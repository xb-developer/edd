import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractMsgMetadata } from "./extractors/msg.js";
import { extractDocContent } from "./extractors/doc.js";

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
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
