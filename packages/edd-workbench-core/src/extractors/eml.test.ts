import { describe, expect, it } from "vitest";
import { extractEmlMetadata } from "./eml.js";

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

    expect(result.from).toContain("jane@example.com");
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

  it("returns nulls/empties for missing optional fields rather than throwing", async () => {
    const minimal = Buffer.from(["Subject: No sender", "", "Just a body."].join("\r\n"), "utf-8");
    const result = await extractEmlMetadata(minimal);

    expect(result.from).toBeNull();
    expect(result.to).toBeNull();
    expect(result.cc).toBeNull();
    expect(result.attachmentFilenames).toEqual([]);
    expect(result.attachments).toEqual([]);
  });
});
