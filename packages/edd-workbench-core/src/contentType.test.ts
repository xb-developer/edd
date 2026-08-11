import { describe, expect, it } from "vitest";
import { detectContentType } from "./contentType.js";

describe("detectContentType", () => {
  it.each([
    ["witness-statement.docx", "docx"],
    ["macro-enabled.docm", "docx"],
    ["custodians.xlsx", "xlsx"],
    ["custodians.xls", "xlsx"],
    ["case-overview.pptx", "pptx"],
    ["draft.eml", "eml"],
    ["sent.msg", "msg"],
    ["bundle.pdf", "pdf"],
    ["photo.png", "image"],
    ["notes.txt", "text"],
    ["legacy-memo.doc", "doc"],
    ["cover-note.rtf", "rtf"],
    ["notes.odt", "odt"],
    ["figures.ods", "ods"],
    ["slides.odp", "odp"],
    ["manual.epub", "epub"],
    ["page.html", "html"],
    ["page.htm", "html"],
    ["custodians.csv", "csv"],
    ["scan.tiff", "tiff"],
    ["scan.tif", "tiff"],
    ["archive.pst", "pst"],
    ["cached.ost", "pst"],
    ["production-set.zip", "zip"],
    ["legacy-deck.ppt", "other"],
    ["drawing.dwg", "other"],
    ["schedule.mpp", "other"],
    ["mystery.xyz", "other"],
    ["no-extension-at-all", "other"],
  ] as const)("detects %s as %s", (filename, expected) => {
    expect(detectContentType(filename)).toBe(expected);
  });

  it("is case-insensitive on the extension", () => {
    expect(detectContentType("WITNESS-STATEMENT.DOCX")).toBe("docx");
  });
});
