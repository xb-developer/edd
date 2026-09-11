import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { extractZipMembers, type ZipMember } from "./zip.js";

// Generous enough never to be the thing under test, except where a test
// deliberately sets its own much smaller ceiling.
const NO_PRACTICAL_LIMIT = 1024 ** 3;

async function buildFixtureZip(entries: Record<string, string>): Promise<Buffer> {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(entries)) zip.file(path, content);
  return zip.generateAsync({ type: "nodebuffer" });
}

async function collect(members: AsyncIterable<ZipMember>): Promise<ZipMember[]> {
  const out: ZipMember[] = [];
  for await (const member of members) out.push(member);
  return out;
}

describe("extractZipMembers", () => {
  it("extracts real bytes and filenames from a genuine zip, including a nested path", async () => {
    const buffer = await buildFixtureZip({
      "exhibit-1.txt": "top-level member",
      "docs/exhibit-2.txt": "nested member",
    });

    const members = await collect(extractZipMembers(buffer, NO_PRACTICAL_LIMIT));

    expect(members).toHaveLength(2);
    const top = members.find((m) => m.zipPath === "exhibit-1.txt");
    const nested = members.find((m) => m.zipPath === "docs/exhibit-2.txt");
    expect(top?.filename).toBe("exhibit-1.txt");
    expect(top?.content.toString("utf-8")).toBe("top-level member");
    expect(nested?.filename).toBe("exhibit-2.txt");
    expect(nested?.content.toString("utf-8")).toBe("nested member");
  });

  it("skips directory entries — a zip with an explicit folder entry yields no member for the folder itself", async () => {
    const zip = new JSZip();
    zip.folder("empty-folder");
    zip.file("real-file.txt", "content");
    const buffer = await zip.generateAsync({ type: "nodebuffer" });

    const members = await collect(extractZipMembers(buffer, NO_PRACTICAL_LIMIT));

    expect(members).toHaveLength(1);
    expect(members[0].filename).toBe("real-file.txt");
  });

  it("throws for bytes that aren't a valid zip, rather than returning an empty/partial result", async () => {
    await expect(collect(extractZipMembers(Buffer.from("not a zip file at all"), NO_PRACTICAL_LIMIT))).rejects.toThrow();
  });

  // The reason this extractor is a generator at all: ZIP_MAX_SIZE_BYTES caps
  // only the COMPRESSED archive, so a high-ratio archive's contents can be
  // an order of magnitude larger than anything that ceiling admits.
  it("throws once the uncompressed contents exceed the ceiling, rather than decompressing the whole archive into memory", async () => {
    // Highly compressible: ~40 KiB of contents from a tiny archive.
    const buffer = await buildFixtureZip({
      "a.txt": "a".repeat(20_000),
      "b.txt": "b".repeat(20_000),
    });

    await expect(collect(extractZipMembers(buffer, 25_000))).rejects.toThrow(/uncompressed contents/);
  });

  it("yields the members that fit before the ceiling is reached — the throw interrupts the walk, it doesn't retroactively discard earlier members", async () => {
    const buffer = await buildFixtureZip({
      "a.txt": "a".repeat(20_000),
      "b.txt": "b".repeat(20_000),
    });

    const seen: string[] = [];
    await expect(
      (async () => {
        for await (const member of extractZipMembers(buffer, 25_000)) seen.push(member.filename);
      })(),
    ).rejects.toThrow(/uncompressed contents/);

    expect(seen).toEqual(["a.txt"]);
  });

  it("admits an archive whose contents sit exactly at the ceiling", async () => {
    const buffer = await buildFixtureZip({ "a.txt": "a".repeat(10_000) });

    const members = await collect(extractZipMembers(buffer, 10_000));

    expect(members).toHaveLength(1);
    expect(members[0].content.byteLength).toBe(10_000);
  });
});
