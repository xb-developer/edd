import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { iteratePstMessages, type PstMessageRecord } from "./pst.js";

// Real Outlook .pst/.ost files, not synthetic — no pure-JS library can
// *write* a byte-accurate PST, so a hand-built fixture would validate
// nothing. Both are copied from the pst-extractor library's own test suite
// (see __fixtures__/NOTICE.md); folder structure/subject/sender values
// below are cross-checked against that project's own
// PSTMessage.spec.ts/PSTFolder.spec.ts/PSTAttachment.spec.ts expected
// values, not derived from this extractor's own logic.
const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__");
const ENRON_PST = join(FIXTURES_DIR, "enron.pst");
const MTNMAN_OST = join(FIXTURES_DIR, "mtnman1965@outlook.com.ost");

async function collect(pstFilePath: string): Promise<PstMessageRecord[]> {
  const records: PstMessageRecord[] = [];
  for await (const record of iteratePstMessages(pstFilePath)) records.push(record);
  return records;
}

describe("iteratePstMessages", () => {
  it("walks every folder (real enron.pst fixture) and yields real subjects/senders matching pst-extractor's own PSTMessage.spec.ts/PSTFolder.spec.ts expected values", async () => {
    const records = await collect(ENRON_PST);

    // PSTFolder.spec.ts's own "root folder should have sub folders" test
    // walks to exactly this folder chain and asserts folder.contentCount
    // (14/7/2/47) plus the "MLOKAY (Non-Privileged)" folder's own direct
    // content (1) — 14+7+2+47+1 = 71, the total real message count.
    expect(records).toHaveLength(71);

    const twCommercial = records.filter(
      (r) => r.folderPath === "Top of Personal Folders/lokay-m/MLOKAY (Non-Privileged)/TW-Commercial Group",
    );
    expect(twCommercial).toHaveLength(14);
    // PSTMessage.spec.ts: first message subject "New OBA's"; second
    // message's sentRepresentingEmailAddress 'JReames@br-inc.com',
    // sentRepresentingName 'Reames Julie', subject exactly as below.
    expect(twCommercial[0].subject).toBe("New OBA's");
    expect(twCommercial[0].messageClass).toBe("IPM.Note");
    expect(twCommercial[1].subject).toBe("I/B Link Capacity for November and December 2001");
    expect(twCommercial[1].from).toContain("JReames@br-inc.com");
    expect(twCommercial[1].from).toContain("Reames Julie");
    expect(twCommercial[1].to).toBe("Michelle Lokay (E-mail)");

    const personalFolder = records.filter(
      (r) => r.folderPath === "Top of Personal Folders/lokay-m/MLOKAY (Non-Privileged)/Personal",
    );
    expect(personalFolder).toHaveLength(47);
    // PSTMessage.spec.ts's "should have email message which uses block
    // skip points" test — the first message in this exact folder.
    expect(personalFolder[0].subject).toBe("Fwd: Enjoy fall in an Alamo midsize car -- just $169 a week!");

    // Search Root/SPAM Search Folder 2 (siblings of "Top of Personal
    // Folders" at the PST root) are real search-folder types whose
    // descriptor tree throws when asked for children (confirmed against
    // this exact fixture) — contribute zero messages, but must not abort
    // the walk of "Top of Personal Folders" that already ran above.
    expect(records.every((r) => r.folderPath.startsWith("Top of Personal Folders"))).toBe(true);
  });

  it("populates sizeBytes from the real PR_MESSAGE_SIZE property (a `long`, converted to a plain number) — not left at 0/unset", async () => {
    const records = await collect(ENRON_PST);
    const twCommercial = records.filter(
      (r) => r.folderPath === "Top of Personal Folders/lokay-m/MLOKAY (Non-Privileged)/TW-Commercial Group",
    );

    // No independently-sourced expected byte count exists for this fixture
    // (pst-extractor's own PSTMessage.spec.ts test file isn't published to
    // npm, unlike the subject/sender values checked above) — asserting a
    // real, plausible positive number is the honest ground truth available
    // here, not a fabricated exact value.
    expect(typeof twCommercial[0].sizeBytes).toBe("number");
    expect(twCommercial[0].sizeBytes).toBeGreaterThan(0);
    expect(Number.isNaN(twCommercial[0].sizeBytes)).toBe(false);
  });

  it("normalizes pst-extractor's empty-string bodyHTML ('no HTML body') to null, matching every other extractor's absent-field contract", async () => {
    const records = await collect(ENRON_PST);

    // Confirmed against this exact fixture: every one of enron.pst's real
    // messages has bodyHTML === '' (plain-text-only mail, no HTML part) —
    // none should surface as an empty, "renderable" string.
    expect(records.length).toBeGreaterThan(0);
    for (const record of records) {
      expect(record.bodyHtml).toBeNull();
    }
  });

  it("reads real BY_VALUE attachment bytes byte-for-byte (real mtnman1965 OST fixture), verified against the original files' own hashes in pst-extractor's test corpus", async () => {
    const records = await collect(MTNMAN_OST);

    const wordMsg = records.find((r) => r.subject === "word attachment");
    const excelMsg = records.find((r) => r.subject === "excel attachment");
    const jpgMsg = records.find((r) => r.subject === "never gonna give you up");
    expect(wordMsg?.attachments).toHaveLength(1);
    expect(excelMsg?.attachments).toHaveLength(1);
    expect(jpgMsg?.attachments).toHaveLength(1);

    const hash = (buffer: Buffer) => createHash("sha256").update(buffer).digest("hex");
    // Hashes of OBA_2760.doc/RedRockA.xls/rickroll.jpg, the same standalone
    // files pst-extractor's own PSTAttachment.spec.ts embeds into this OST
    // — computed directly from those files in the library's real test
    // corpus (see __fixtures__/NOTICE.md), not derived from this
    // extractor's own output.
    expect(wordMsg!.attachments[0].filename).toBe("OBA_2760.doc");
    expect(hash(wordMsg!.attachments[0].content)).toBe("1fc99f9b8479bcbe0504334980bccd172982b951887eec41f0e48127d5d009d8");
    expect(excelMsg!.attachments[0].filename).toBe("RedRockA.xls");
    expect(hash(excelMsg!.attachments[0].content)).toBe("d2479945000f55ced30c80d1db2abd3fec7f8c7e82f7d76b49b77450ce314abf");
    expect(jpgMsg!.attachments[0].filename).toBe("rickroll.jpg");
    expect(hash(jpgMsg!.attachments[0].content)).toBe("acef4761a1252a2a7ed2a8aae4ba19f770c4397cb87ef9bea0e6a5c6dae92ebd");

    // attachmentFilenames (the JSON-serializable metadata field) must list
    // the same real names, not just the byte-carrying `attachments` array.
    expect(wordMsg!.attachmentFilenames).toEqual(["OBA_2760.doc"]);
  });

  it("walks Deleted Items too (nothing silently dropped from a preservation standpoint) and skips non-email items (contacts/tasks) entirely", async () => {
    const records = await collect(MTNMAN_OST);

    // "Today: workout" is a real IPM.Note.Agenda item that really lives in
    // this OST's Deleted Items folder (confirmed against this exact
    // fixture) — proves Deleted Items gets walked, and that the
    // IPM.Note.Agenda variant (not just plain "IPM.Note") is treated as a
    // real email, matching pst-extractor's own message-class switch.
    const deleted = records.find((r) => r.folderPath === "Root - Mailbox/IPM_SUBTREE/Deleted Items");
    expect(deleted?.subject).toBe("Today: workout");
    expect(deleted?.messageClass).toBe("IPM.Note.Agenda");
    expect(deleted?.attachments.map((a) => a.filename)).toEqual([
      "outlookLogo.png",
      "SkyCode_32pct_11.png",
      "time.png",
      "location.png",
      "defaultCalendar.png",
    ]);

    // This OST's real Contacts folder (verified separately to hold an
    // IPM.Contact with 2 attachments) and Tasks folder (an IPM.Task with
    // its own attachment) must contribute zero messages — every yielded
    // record's messageClass must start with "IPM.Note".
    expect(records.every((r) => r.messageClass.startsWith("IPM.Note"))).toBe(true);
    expect(records.some((r) => r.messageClass === "IPM.Contact")).toBe(false);
    expect(records.some((r) => r.messageClass === "IPM.Task")).toBe(false);
  });

  it("throws for a genuinely corrupt/non-PST file, matching pst-extractor's own documented 'does not work with corrupt PST files' limitation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pst-corrupt-test-"));
    const corruptPath = join(dir, "corrupt.pst");
    writeFileSync(corruptPath, Buffer.from("not a real pst file at all, just garbage bytes for this test"));

    try {
      const generator = iteratePstMessages(corruptPath);
      await expect(generator.next()).rejects.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws for a path that doesn't exist at all", async () => {
    const generator = iteratePstMessages(join(FIXTURES_DIR, "does-not-exist.pst"));
    await expect(generator.next()).rejects.toThrow();
  });
});
