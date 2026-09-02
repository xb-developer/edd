import { describe, expect, it } from "vitest";
import { resolveEmbeddableText } from "./embeddableText.js";

describe("resolveEmbeddableText", () => {
  it("excludes spreadsheet/csv/pptx content types regardless of metadata", () => {
    expect(resolveEmbeddableText("xlsx", { text: "real text" })).toBeNull();
    expect(resolveEmbeddableText("csv", { text: "real text" })).toBeNull();
    expect(resolveEmbeddableText("pptx", { text: "real text" })).toBeNull();
  });

  it("returns null when metadata is null", () => {
    expect(resolveEmbeddableText("eml", null)).toBeNull();
  });

  it("prefers bodyText (eml/msg) when present", () => {
    expect(resolveEmbeddableText("eml", { bodyText: "  Hello there  ", html: "<p>ignored</p>" })).toBe("Hello there");
  });

  it("uses text (pdf/image/officeText) when bodyText is absent", () => {
    expect(resolveEmbeddableText("pdf", { text: "  Extracted text  " })).toBe("Extracted text");
  });

  it("strips HTML down to plain text when only html is present (docx/doc)", () => {
    const result = resolveEmbeddableText("docx", { html: "<p>Hello <b>world</b></p>" });
    expect(result).toContain("Hello");
    expect(result).toContain("world");
    expect(result).not.toContain("<");
  });

  it("returns null when every field is empty/whitespace-only", () => {
    expect(resolveEmbeddableText("eml", { bodyText: "   ", text: null, html: "" })).toBeNull();
  });
});
