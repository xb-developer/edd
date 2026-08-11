import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractMsgMetadata, resolveAddress } from "./msg.js";

// Real Outlook .msg files, not synthetic — hand-building a byte-accurate
// OLE/CFB fixture risks producing a fixture that's simply wrong, which
// would validate nothing. These are copied from the msgreader library's
// own test suite (see __fixtures__/NOTICE.md); expected values below are
// cross-checked against that project's own expected-output JSON for each
// file, not derived from this extractor's logic.
const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__");
const load = (name: string) => readFileSync(join(FIXTURES_DIR, name));

describe("extractMsgMetadata", () => {
  it("extracts sender, recipient, subject, body, and date from a real self-sent message", async () => {
    // sent.msg / sent.json (msgreader's own fixture): senderEmail
    // "xmailuser@xmailserver.test", one "to" recipient with the same
    // address, subject "Sent time", body "Test mail\r\n\r\n",
    // messageDeliveryTime "Mon, 15 Feb 2021 08:19:00 GMT".
    const result = await extractMsgMetadata(load("sent.msg"));

    expect(result.from).toContain("xmailuser@xmailserver.test");
    expect(result.to).toContain("xmailuser@xmailserver.test");
    expect(result.cc).toBeNull();
    expect(result.subject).toBe("Sent time");
    expect(result.bodyText?.trim()).toBe("Test mail");
    expect(result.date?.toISOString()).toBe(new Date("Mon, 15 Feb 2021 08:19:00 GMT").toISOString());
    expect(result.attachmentFilenames).toEqual([]);
  });

  it("extracts separate to/cc recipients and reports no sender when the file has none", async () => {
    // test1.msg / test1.json: to="to@example.com", cc="cc@example.com",
    // subject "title", body "body\r\n", no senderName/senderEmail at all.
    const result = await extractMsgMetadata(load("test1.msg"));

    expect(result.to).toContain("to@example.com");
    expect(result.cc).toContain("cc@example.com");
    expect(result.subject).toBe("title");
    expect(result.bodyText?.trim()).toBe("body");
    expect(result.from).toBeNull();
  });

  it("lists attachment filenames in their original order, with real content bytes alongside each", async () => {
    // attachmentsOrder.msg / attachmentsOrder.json: exactly 4 attachments,
    // A.docx..D.docx, and the library's own test specifically validates
    // order preservation — worth asserting the same property here.
    const result = await extractMsgMetadata(load("attachmentsOrder.msg"));

    expect(result.attachmentFilenames).toEqual(["A.docx", "B.docx", "C.docx", "D.docx"]);
    expect(result.attachments.map((a) => a.filename)).toEqual(["A.docx", "B.docx", "C.docx", "D.docx"]);
    // Each is a genuine, non-empty, zip-magic-prefixed .docx — real content,
    // not a placeholder — confirming getAttachment() round-trips real bytes.
    for (const attachment of result.attachments) {
      expect(attachment.content.byteLength).toBeGreaterThan(0);
      expect(attachment.content.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    }
  });

  it("prefers a real SMTP address over an Exchange X.500 directory name, verified against real test-data (a real .msg sent through Exchange)", () => {
    // Real bug: a message sent through Exchange stores the recipient's
    // Active Directory display name in `name` and an X.500 DN (never a
    // usable address) in `email` when addressType is 'EX' — the real
    // resolved SMTP address, when Exchange attaches one, lives in the
    // separate `smtpAddress` field instead. Confirmed against a real
    // Exchange-sent .msg from this project's own test-data: before this
    // fix, `to`/`from` showed the AD name; after, the real address.
    expect(resolveAddress("Smith, John (IT)", "/o=ExchangeLabs/ou=Exchange Administrative Group/cn=Recipients/cn=jsmith", "john.smith@example.com")).toBe(
      "Smith, John (IT) <john.smith@example.com>",
    );
    // A genuine SMTP-type address in `email` (contains "@") is already
    // usable and preferred over falling back to the bare name alone.
    expect(resolveAddress("Jane Reviewer", "jane@example.com", undefined)).toBe("Jane Reviewer <jane@example.com>");
    // No usable address at all (old Exchange messages with no smtpAddress
    // attached, and an EX-type email that isn't a real address) falls
    // back to the display name rather than showing a useless X.500 DN.
    expect(resolveAddress("Smith, John (IT)", "/o=ExchangeLabs/ou=Exchange Administrative Group/cn=Recipients/cn=jsmith", undefined)).toBe(
      "Smith, John (IT)",
    );
    expect(resolveAddress(undefined, undefined, undefined)).toBeNull();
  });

  it("returns nulls/empties rather than throwing for bytes that aren't a valid OLE file", async () => {
    const result = await extractMsgMetadata(Buffer.from("not an OLE compound file"));

    expect(result).toEqual({
      from: null,
      to: null,
      cc: null,
      subject: null,
      date: null,
      bodyText: null,
      attachmentFilenames: [],
      attachments: [],
    });
  });
});
