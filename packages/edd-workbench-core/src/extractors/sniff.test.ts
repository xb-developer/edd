import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { looksLikeRtf, looksLikeText, looksLikeZip } from "./sniff.js";

describe("looksLikeRtf", () => {
  it("recognizes a real RTF header", () => {
    expect(looksLikeRtf(Buffer.from("{\\rtf1\\ansi Hello}"))).toBe(true);
  });

  it("rejects non-RTF bytes", () => {
    expect(looksLikeRtf(Buffer.from("not rtf at all"))).toBe(false);
  });
});

describe("looksLikeZip", () => {
  it("recognizes a real zip built with JSZip", async () => {
    const zip = new JSZip();
    zip.file("hello.txt", "hi");
    const buffer = await zip.generateAsync({ type: "nodebuffer" });
    expect(looksLikeZip(buffer)).toBe(true);
  });

  it("rejects non-zip bytes", () => {
    expect(looksLikeZip(Buffer.from("PK is not enough on its own"))).toBe(false);
  });
});

describe("looksLikeText", () => {
  it("accepts plain UTF-8 text", () => {
    expect(looksLikeText(Buffer.from("Please review the attached draft — thanks."))).toBe(true);
  });

  it("rejects binary data containing a NUL byte", () => {
    expect(looksLikeText(Buffer.from([0x50, 0x4b, 0x00, 0x04, 0x01, 0x02]))).toBe(false);
  });

  it("rejects a buffer dominated by non-printable control bytes", () => {
    const binary = Buffer.from(Array.from({ length: 200 }, (_, i) => (i % 30) + 1));
    expect(looksLikeText(binary)).toBe(false);
  });

  it("treats an empty buffer as plausible text (nothing to contradict it)", () => {
    expect(looksLikeText(Buffer.alloc(0))).toBe(true);
  });
});
