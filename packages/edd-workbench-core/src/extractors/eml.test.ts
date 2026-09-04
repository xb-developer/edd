import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractEmlMetadata } from "./eml.js";

// A genuine, real-world Outlook message Nick supplied specifically to
// reproduce a real attachment-recursion bug: a forwarded email attached as
// a `message/rfc822` part with NO filename parameter on its own
// Content-Disposition at all (only creation-date/modification-date) —
// confirmed a real, common Outlook shape, not a hypothetical. See
// test-data/README (if any) — this lives in the repo-root test-data/
// directory per ONBOARDING.md's own convention for real Nick-supplied
// fixtures, not duplicated into this package's __fixtures__ dir.
const REAL_FIXTURE_WITH_UNNAMED_FORWARD = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../../../test-data/eml/Processing check.eml"),
);

// A genuine, hand-written multipart/mixed message whose one attachment is
// a real message/rfc822 part with no filename param — the minimal,
// isolated repro of the same real shape above, for a fast assertion on
// the exact fallback-naming logic without needing the full ~2MB real file.
function buildEmlWithUnnamedForward(): Buffer {
  return Buffer.from(
    [
      'From: "Jane Reviewer" <jane@example.com>',
      "Subject: Fwd: no filename on the forward",
      "Date: Mon, 12 Jan 2026 09:30:00 +0000",
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="OUTER-BOUNDARY"',
      "",
      "--OUTER-BOUNDARY",
      'Content-Type: text/plain; charset="utf-8"',
      "",
      "See the forwarded message below.",
      "",
      "--OUTER-BOUNDARY",
      "Content-Type: message/rfc822",
      'Content-Disposition: attachment; creation-date="Tue, 11 Aug 2026 13:14:33 GMT"',
      "",
      'From: "Original Sender" <original@example.com>',
      "Subject: The original message",
      "",
      "Original body.",
      "--OUTER-BOUNDARY--",
      "",
    ].join("\r\n"),
    "utf-8",
  );
}

// A genuine, hand-written multipart/mixed MIME message — nested
// multipart/alternative (plain + HTML body) plus one attachment — not a
// stub. Real values below are asserted directly from this fixture's own
// literal content, not re-derived through the extractor's own logic.
const FIXTURE_EML = Buffer.from(
  [
    'From: "Jane Reviewer" <jane@example.com>',
    'To: "John Admin" <john@example.com>',
    'Cc: "Case Team" <case-team@example.com>',
    "Subject: Re: Draft disclosure list",
    "Date: Mon, 12 Jan 2026 09:30:00 +0000",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="OUTER-BOUNDARY"',
    "",
    "--OUTER-BOUNDARY",
    'Content-Type: multipart/alternative; boundary="INNER-BOUNDARY"',
    "",
    "--INNER-BOUNDARY",
    'Content-Type: text/plain; charset="utf-8"',
    "",
    "Please see the attached draft list for review.",
    "",
    "--INNER-BOUNDARY",
    'Content-Type: text/html; charset="utf-8"',
    "",
    "<p>Please see the attached draft list for review.</p>",
    "",
    "--INNER-BOUNDARY--",
    "--OUTER-BOUNDARY",
    'Content-Type: application/pdf; name="draft-list.pdf"',
    'Content-Disposition: attachment; filename="draft-list.pdf"',
    "Content-Transfer-Encoding: base64",
    "",
    "JVBERi0xLjQK",
    "--OUTER-BOUNDARY--",
    "",
  ].join("\r\n"),
  "utf-8",
);

// A genuine multipart/related structure with an inline signature image
// actually referenced by cid: in the HTML body, sitting alongside a real
// standalone attachment in the outer multipart/mixed — the shape a real
// signed-email-with-a-logo produces. Real values asserted from this
// fixture's own literal content.
const FIXTURE_EML_WITH_INLINE_IMAGE = Buffer.from(
  [
    'From: "Jane Reviewer" <jane@example.com>',
    'To: "John Admin" <john@example.com>',
    "Subject: Signed with a logo",
    "Date: Mon, 12 Jan 2026 09:30:00 +0000",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="OUTER-BOUNDARY"',
    "",
    "--OUTER-BOUNDARY",
    'Content-Type: multipart/related; boundary="REL-BOUNDARY"',
    "",
    "--REL-BOUNDARY",
    'Content-Type: text/html; charset="utf-8"',
    "",
    '<p>See you then.</p><img src="cid:logo123">',
    "",
    "--REL-BOUNDARY",
    "Content-Type: image/png",
    "Content-ID: <logo123>",
    'Content-Disposition: inline; filename="logo.png"',
    "Content-Transfer-Encoding: base64",
    "",
    "aW1hZ2VieXRlcw==",
    "--REL-BOUNDARY--",
    "--OUTER-BOUNDARY",
    'Content-Type: application/pdf; name="draft-list.pdf"',
    'Content-Disposition: attachment; filename="draft-list.pdf"',
    "Content-Transfer-Encoding: base64",
    "",
    "JVBERi0xLjQK",
    "--OUTER-BOUNDARY--",
    "",
  ].join("\r\n"),
  "utf-8",
);

describe("extractEmlMetadata", () => {
  it("extracts headers, both body variants, and attachment filenames from a real MIME message", async () => {
    const result = await extractEmlMetadata(FIXTURE_EML);

    // "Jane Reviewer" <jane@example.com> — a display name is present, so
    // `from` (used directly as the document's author) is the name alone,
    // not the combined "Name <address>" form addressText would give.
    expect(result.from).toBe("Jane Reviewer");
    expect(result.to).toContain("john@example.com");
    expect(result.cc).toContain("case-team@example.com");
    expect(result.subject).toBe("Re: Draft disclosure list");
    expect(result.date?.toISOString()).toBe(new Date("2026-01-12T09:30:00.000Z").toISOString());
    expect(result.bodyText?.trim()).toBe("Please see the attached draft list for review.");
    expect(result.bodyHtml).toContain("<p>Please see the attached draft list for review.</p>");
    expect(result.attachmentFilenames).toEqual(["draft-list.pdf"]);
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0].filename).toBe("draft-list.pdf");
    expect(result.attachments[0].content.toString("utf-8")).toBe("%PDF-1.4\n");
  });

  it("excludes an inline cid:-referenced image from attachments/attachmentFilenames, keeping a real sibling attachment", async () => {
    const result = await extractEmlMetadata(FIXTURE_EML_WITH_INLINE_IMAGE);

    expect(result.attachmentFilenames).toEqual(["draft-list.pdf"]);
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0].filename).toBe("draft-list.pdf");
  });

  it("falls back to the sender's bare address when the From header has no display name", async () => {
    const noNameSender = Buffer.from(
      ["From: jane@example.com", "Subject: No display name", "", "Just a body."].join("\r\n"),
      "utf-8",
    );
    const result = await extractEmlMetadata(noNameSender);

    expect(result.from).toBe("jane@example.com");
  });

  it("returns nulls/empties for missing optional fields rather than throwing", async () => {
    const minimal = Buffer.from(["Subject: No sender", "", "Just a body."].join("\r\n"), "utf-8");
    const result = await extractEmlMetadata(minimal);

    expect(result.from).toBeNull();
    expect(result.to).toBeNull();
    expect(result.cc).toBeNull();
    expect(result.attachmentFilenames).toEqual([]);
    expect(result.attachments).toEqual([]);
  });

  it("gives a filename-less message/rfc822 attachment a real '.eml' extension instead of a bare, extension-less 'unnamed' — the exact fix for a real attachment-recursion bug (a forwarded email attached with no filename param, a common real Outlook shape, used to be classified as 'other' downstream and never recursed into)", async () => {
    const result = await extractEmlMetadata(buildEmlWithUnnamedForward());

    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0].filename).toBe("unnamed.eml");
    expect(result.attachmentFilenames).toEqual(["unnamed.eml"]);
    expect(result.attachments[0].content.toString("utf-8")).toContain("The original message");
  });

  it("leaves a filename-less NON-message/rfc822 attachment as plain 'unnamed' — the fix is scoped to the one content-type that actually needs to recurse, not a blanket rename", async () => {
    const eml = Buffer.from(
      [
        'From: "Jane Reviewer" <jane@example.com>',
        "Subject: Odd attachment with no filename",
        "MIME-Version: 1.0",
        'Content-Type: multipart/mixed; boundary="B"',
        "",
        "--B",
        'Content-Type: text/plain; charset="utf-8"',
        "",
        "body",
        "--B",
        "Content-Type: application/octet-stream",
        "Content-Disposition: attachment",
        "Content-Transfer-Encoding: base64",
        "",
        "cmF3Ynl0ZXM=",
        "--B--",
        "",
      ].join("\r\n"),
      "utf-8",
    );

    const result = await extractEmlMetadata(eml);

    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0].filename).toBe("unnamed");
  });

  it("real fixture: a real Outlook-forwarded email attached with no filename param at all gets a real '.eml' filename, alongside its own real named PDF attachments", async () => {
    const result = await extractEmlMetadata(REAL_FIXTURE_WITH_UNNAMED_FORWARD);

    expect(result.subject).toBe("Processing check");
    // 4 real inline cid:-referenced signature images are correctly
    // excluded — only the 3 real evidentiary attachments remain: the
    // filename-less forwarded email plus its two named PDF siblings.
    expect(result.attachmentFilenames).toEqual(["unnamed.eml", "Blue sky.pdf", "PRACTICE DIRECTION 51U - DISCLOSURE PILOT FOR THE BUSINESS AND PROPERTY COURTS.pdf"]);

    const forwarded = result.attachments.find((a) => a.filename === "unnamed.eml");
    expect(forwarded).toBeTruthy();
    // Real bytes of the nested message, not a stub — its own real subject
    // line is genuinely present in the raw content, provable without even
    // re-parsing it (that's ingest.ts's own recursion's job, tested at the
    // integration level in ingest.test.ts).
    expect(forwarded!.content.toString("utf-8")).toContain("Subject: RE: Kitchens and Dishes - Fleet Street");
  });
});
