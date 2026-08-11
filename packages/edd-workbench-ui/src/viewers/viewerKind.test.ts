import { describe, expect, it } from "vitest";
import { viewerKindFor } from "./viewerKind.js";

describe("viewerKindFor", () => {
  it.each([
    ["pdf", "native-pdf"],
    ["image", "native-image"],
    ["text", "native-text"],
    ["eml", "email"],
    ["msg", "email"],
    ["docx", "docx"],
    ["xlsx", "xlsx"],
    ["csv", "xlsx"],
    ["pptx", "pptx"],
    ["doc", "extracted-text"],
    ["rtf", "extracted-text"],
    ["odt", "extracted-text"],
    ["ods", "extracted-text"],
    ["odp", "extracted-text"],
    ["epub", "extracted-text"],
    ["html", "extracted-text"],
    ["other", "unsupported"],
  ] as const)("maps content type %s to viewer kind %s", (contentType, expected) => {
    expect(viewerKindFor(contentType)).toBe(expected);
  });
});
