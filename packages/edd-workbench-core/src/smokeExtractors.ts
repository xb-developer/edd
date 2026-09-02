import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sevenZip from "7zip-min";
import { extractMsgMetadata } from "./extractors/msg.js";
import { extractDocContent } from "./extractors/doc.js";
import { extractSevenZipMembers } from "./extractors/sevenZip.js";
import { iterateMboxMessages } from "./extractors/mbox.js";

/**
 * Runs outside Vitest, on purpose. Vitest's esbuild-based module loader
 * unwraps CJS default exports one level further than plain Node's native
 * ESM loader does — a real bug (extractMsgMetadata silently returning
 * null metadata for every .msg file under the actual running worker) was
 * invisible to the full Vitest suite, which kept passing throughout. A
 * Vitest test cannot catch a regression of this class, since Vitest's own
 * loader is what masks it — this has to run under the same plain `tsx`
 * process the worker actually uses in production.
 */
async function run(): Promise<void> {
  const fixturePath = join(
    dirname(fileURLToPath(import.meta.url)),
    "extractors/__fixtures__/sent.msg",
  );
  const buffer = readFileSync(fixturePath);
  const result = await extractMsgMetadata(buffer);

  if (result.subject !== "Sent time") {
    throw new Error(`smoke-extractors: expected subject "Sent time", got ${JSON.stringify(result.subject)}`);
  }
  if (!result.from?.includes("xmailuser@xmailserver.test")) {
    throw new Error(`smoke-extractors: expected from to contain "xmailuser@xmailserver.test", got ${JSON.stringify(result.from)}`);
  }

  console.log("smoke-extractors: OK (extractMsgMetadata resolves its real constructor under plain Node ESM)");

  // word-extractor's CJS export is `module.exports = WordExtractor` (a bare
  // class, no `.default` wrapper) — inspected directly and confirmed to be
  // the "safe" shape both Vitest/esbuild's and plain Node's ESM interop
  // agree on, unlike msg.ts's case above. Checked here anyway, under the
  // same plain-tsx process the worker actually runs, as a guard against a
  // future word-extractor version silently changing that shape — this
  // protection shouldn't stay permanently scoped to only the one dependency
  // that has already bitten this project once.
  const legacyDocPath = join(dirname(fileURLToPath(import.meta.url)), "extractors/__fixtures__/legacy01.doc");
  const docResult = await extractDocContent(readFileSync(legacyDocPath));
  if (docResult.detectedFormat !== "doc" || !docResult.text?.includes("This is a test of reviewing")) {
    throw new Error(`smoke-extractors: expected a real legacy .doc extraction, got ${JSON.stringify(docResult)}`);
  }

  console.log("smoke-extractors: OK (extractDocContent resolves word-extractor's real constructor under plain Node ESM)");

  // 7zip-min exports each function via a separate `exports.x = ...`
  // assignment (no `exports.default`), the same shape already confirmed
  // safe for word-extractor above — checked here anyway under plain tsx,
  // since sevenZip.ts's own `import sevenZip from "7zip-min"` default
  // import depends on that shape resolving the same way it does under
  // Vitest's esbuild loader.
  const sevenZipWorkDir = await mkdtemp(join(tmpdir(), "smoke-7z-"));
  try {
    const srcPath = join(sevenZipWorkDir, "exhibit.txt");
    await writeFile(srcPath, "smoke-test content");
    const archivePath = join(sevenZipWorkDir, "archive.7z");
    await sevenZip.pack(srcPath, archivePath);

    const extractDir = join(sevenZipWorkDir, "extracted");
    const members = [];
    for await (const member of extractSevenZipMembers(archivePath, extractDir, 1024 * 1024)) {
      members.push(member);
    }
    if (members.length !== 1 || members[0].content.toString("utf-8") !== "smoke-test content") {
      throw new Error(`smoke-extractors: expected one real 7z member with "smoke-test content", got ${JSON.stringify(members)}`);
    }
  } finally {
    await rm(sevenZipWorkDir, { recursive: true, force: true });
  }

  console.log("smoke-extractors: OK (extractSevenZipMembers resolves 7zip-min's real functions under plain Node ESM)");

  // mbox-reader's `mboxReader` is a named CJS export
  // (`module.exports = { MboxReader, mboxReader }`) — a different shape
  // again from the two above, checked here for the same reason.
  const mboxWorkDir = await mkdtemp(join(tmpdir(), "smoke-mbox-"));
  try {
    const mboxPath = join(mboxWorkDir, "mailbox.mbox");
    await writeFile(mboxPath, ["From smoke@example.com Mon Jan 12 09:30:00 2026", "Subject: smoke test", "", "smoke-test body", ""].join("\n"));

    const messages = [];
    for await (const message of iterateMboxMessages(mboxPath)) {
      messages.push(message);
    }
    if (messages.length !== 1 || !messages[0].toString("utf-8").includes("smoke-test body")) {
      throw new Error(`smoke-extractors: expected one real mbox message containing "smoke-test body", got ${JSON.stringify(messages.map(String))}`);
    }
  } finally {
    await rm(mboxWorkDir, { recursive: true, force: true });
  }

  console.log("smoke-extractors: OK (iterateMboxMessages resolves mbox-reader's real mboxReader under plain Node ESM)");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
