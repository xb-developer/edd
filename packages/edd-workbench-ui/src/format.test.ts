import { describe, expect, it } from "vitest";
import { formatDate, formatSize, displayFilename, stripExtension } from "./format.js";

describe("formatDate", () => {
  it("formats an already-UTC ISO timestamp as dd/MM/YYYY HH:mm:ss +0000", () => {
    expect(formatDate("2026-01-12T09:30:05.000Z")).toBe("12/01/2026 09:30:05 +0000");
  });

  it("converts a non-UTC-offset timestamp TO UTC — not just reformatting it as if it already were UTC", () => {
    // 14:30 in UTC-05:00 is 19:30 UTC — proves this is a real conversion.
    expect(formatDate("2026-01-12T14:30:00-05:00")).toBe("12/01/2026 19:30:00 +0000");
  });

  it("rolls over to the next UTC day when the source offset pushes it past midnight", () => {
    // 23:00 in UTC+02:00 is 21:00 UTC the SAME day, but 23:30 in UTC-02:00
    // is 01:30 UTC the NEXT day — a real day-boundary crossing, not just a
    // time-of-day change.
    expect(formatDate("2026-01-12T23:30:00-02:00")).toBe("13/01/2026 01:30:00 +0000");
  });

  it("zero-pads every component below double digits", () => {
    expect(formatDate("2026-03-05T01:02:03.000Z")).toBe("05/03/2026 01:02:03 +0000");
  });

  it("falls back to an em dash for a null value", () => {
    expect(formatDate(null)).toBe("—");
  });
});

describe("formatSize", () => {
  it("formats bytes below 1024 as a plain byte count", () => {
    expect(formatSize(512)).toBe("512 B");
  });

  it("formats bytes in the KB range", () => {
    expect(formatSize(1536)).toBe("1.5 KB");
  });

  it("formats bytes in the MB range", () => {
    expect(formatSize(1.5 * 1024 ** 2)).toBe("1.5 MB");
  });

  it("formats bytes in the GB range — the tier that was missing before this fix", () => {
    expect(formatSize(2.5 * 1024 ** 3)).toBe("2.5 GB");
  });

  it("stays in MB just below the GB boundary", () => {
    expect(formatSize(1024 ** 3 - 1)).toBe("1024.0 MB");
  });
});

describe("displayFilename", () => {
  it("prefers the extracted Subject over the stored filename for an eml document", () => {
    expect(
      displayFilename({ originalFilename: "unnamed.eml", contentTypeDetected: "eml", title: "RE: Kitchens and Dishes - Fleet Street" }),
    ).toBe("RE: Kitchens and Dishes - Fleet Street");
  });

  it("prefers Subject for a top-level eml too, not just filename-less attachments", () => {
    expect(displayFilename({ originalFilename: "Processing check.eml", contentTypeDetected: "eml", title: "Processing check" })).toBe(
      "Processing check",
    );
  });

  it("prefers Subject for msg documents the same way as eml", () => {
    expect(displayFilename({ originalFilename: "message.msg", contentTypeDetected: "msg", title: "Quarterly review" })).toBe(
      "Quarterly review",
    );
  });

  it("falls back to the filename when title is empty (extraction not yet complete)", () => {
    expect(displayFilename({ originalFilename: "correspondence.eml", contentTypeDetected: "eml", title: null })).toBe("correspondence.eml");
  });

  it("never applies Subject-preference to a non-email document", () => {
    expect(displayFilename({ originalFilename: "bundle.pdf", contentTypeDetected: "pdf", title: "Some unrelated title" })).toBe("bundle.pdf");
  });
});

describe("stripExtension", () => {
  it("strips a matching trailing extension", () => {
    expect(stripExtension("Blue sky.pdf", "pdf")).toBe("Blue sky");
  });

  it("is case-insensitive", () => {
    expect(stripExtension("Blue Sky.PDF", "pdf")).toBe("Blue Sky");
  });

  it("leaves a name unchanged when it doesn't end with that extension", () => {
    expect(stripExtension("RE: Kitchens and Dishes - Fleet Street", "eml")).toBe("RE: Kitchens and Dishes - Fleet Street");
  });

  it("doesn't mis-truncate a name that merely contains a literal '.' before other text", () => {
    expect(stripExtension("Acme v. Smith", "pdf")).toBe("Acme v. Smith");
  });

  it("leaves the name unchanged when extension is empty", () => {
    expect(stripExtension("README", "")).toBe("README");
  });
});
