import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { extractZipMembers } from "./zip.js";

async function buildFixtureZip(entries: Record<string, string>): Promise<Buffer> {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(entries)) zip.file(path, content);
  return zip.generateAsync({ type: "nodebuffer" });
}

describe("extractZipMembers", () => {
  it("extracts real bytes and filenames from a genuine zip, including a nested path", async () => {
    const buffer = await buildFixtureZip({
      "exhibit-1.txt": "top-level member",
      "docs/exhibit-2.txt": "nested member",
    });

    const members = await extractZipMembers(buffer);

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

    const members = await extractZipMembers(buffer);

    expect(members).toHaveLength(1);
    expect(members[0].filename).toBe("real-file.txt");
  });

  it("throws for bytes that aren't a valid zip, rather than returning an empty/partial result", async () => {
    await expect(extractZipMembers(Buffer.from("not a zip file at all"))).rejects.toThrow();
  });
});
