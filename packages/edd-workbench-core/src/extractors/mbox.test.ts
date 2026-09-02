import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { iterateMboxMessages } from "./mbox.js";

// A genuine, hand-written mbox file — two real RFC822 messages separated
// by classic Unix "From " boundary lines — not a stub, same precedent
// eml.test.ts's own hand-written MIME fixture already establishes (no
// writer library is needed; the format is simple enough to construct
// correctly by hand). The second message's body deliberately includes a
// line starting with "From " in its own real content, escaped here as
// ">From " per the mboxrd convention real mbox writers use — proving
// iterateMboxMessages's underlying parser un-escapes it back to the
// original unescaped line, not merely that it can split messages apart.
const FIXTURE_MBOX = [
  "From jane@example.com Mon Jan 12 09:30:00 2026",
  'From: "Jane Reviewer" <jane@example.com>',
  'To: "John Admin" <john@example.com>',
  "Subject: Draft disclosure list",
  "Date: Mon, 12 Jan 2026 09:30:00 +0000",
  "MIME-Version: 1.0",
  'Content-Type: text/plain; charset="utf-8"',
  "",
  "Please see the attached draft list for review.",
  "",
  "From john@example.com Mon Jan 12 10:15:00 2026",
  'From: "John Admin" <john@example.com>',
  'To: "Jane Reviewer" <jane@example.com>',
  "Subject: Re: Draft disclosure list",
  "Date: Mon, 12 Jan 2026 10:15:00 +0000",
  "MIME-Version: 1.0",
  'Content-Type: text/plain; charset="utf-8"',
  "",
  "Reviewed, looks good.",
  ">From the field team's own status update, quoted below:",
  "Approved for production.",
  "",
].join("\n");

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function writeFixtureFile(content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mbox-fixture-"));
  tempDirs.push(dir);
  const filePath = join(dir, "mailbox.mbox");
  await writeFile(filePath, content);
  return filePath;
}

async function collectMessages(filePath: string): Promise<Buffer[]> {
  const messages: Buffer[] = [];
  for await (const message of iterateMboxMessages(filePath)) {
    messages.push(message);
  }
  return messages;
}

describe("iterateMboxMessages", () => {
  it("splits a genuine mbox file into its real individual RFC822 messages", async () => {
    const filePath = await writeFixtureFile(FIXTURE_MBOX);

    const messages = await collectMessages(filePath);

    expect(messages).toHaveLength(2);
    expect(messages[0].toString("utf-8")).toContain("Subject: Draft disclosure list");
    expect(messages[0].toString("utf-8")).toContain("Please see the attached draft list for review.");
    expect(messages[1].toString("utf-8")).toContain("Subject: Re: Draft disclosure list");
  });

  it("un-escapes an mboxrd-escaped body line back to its real, unescaped original", async () => {
    const filePath = await writeFixtureFile(FIXTURE_MBOX);

    const messages = await collectMessages(filePath);
    const secondBody = messages[1].toString("utf-8");

    expect(secondBody).toContain("From the field team's own status update, quoted below:");
    expect(secondBody).not.toContain(">From the field team's own status update");
  });

  it("yields nothing for an empty file, rather than throwing", async () => {
    const filePath = await writeFixtureFile("");

    const messages = await collectMessages(filePath);

    expect(messages).toHaveLength(0);
  });
});
