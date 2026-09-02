import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import sevenZip from "7zip-min";
import { afterEach, describe, expect, it } from "vitest";
import { extractSevenZipMembers } from "./sevenZip.js";

const DEFAULT_MAX_UNCOMPRESSED_BYTES = 10 * 1024 ** 2;
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function trackedTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/**
 * Builds a genuine .7z archive using 7zip-min's own real `pack()` — same
 * "use the real writer of the format you're testing the reader for"
 * precedent zip.test.ts's buildFixtureZip already establishes for JSZip,
 * so no externally-sourced binary fixture is needed. Packing
 * `${srcDir}/*` (a wildcard 7-Zip itself expands, not the shell — `pack`
 * spawns the binary directly, no shell involved) rather than `srcDir`
 * itself avoids 7-Zip's default behavior of wrapping the source directory
 * itself as a top-level entry, keeping the resulting archive's internal
 * paths exactly the ones written below (confirmed against a real archive
 * via a throwaway diagnostic script, per this repo's own convention for
 * proving real behavior before relying on it).
 */
async function buildFixtureSevenZip(entries: Record<string, string>): Promise<string> {
  const srcDir = await trackedTempDir("sevenzip-fixture-src-");
  for (const [path, content] of Object.entries(entries)) {
    const fullPath = join(srcDir, path);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content);
  }
  const archivePath = join(await trackedTempDir("sevenzip-fixture-arch-"), "archive.7z");
  await sevenZip.pack(join(srcDir, "*"), archivePath);
  return archivePath;
}

async function collectMembers(
  archivePath: string,
  maxUncompressedBytes = DEFAULT_MAX_UNCOMPRESSED_BYTES,
) {
  const extractDir = await trackedTempDir("sevenzip-extract-");
  const members = [];
  for await (const member of extractSevenZipMembers(archivePath, extractDir, maxUncompressedBytes)) {
    members.push(member);
  }
  return members;
}

describe("extractSevenZipMembers", () => {
  it("extracts real bytes and filenames from a genuine 7z, including a nested path", async () => {
    const archivePath = await buildFixtureSevenZip({
      "exhibit-1.txt": "top-level member",
      "docs/exhibit-2.txt": "nested member",
    });

    const members = await collectMembers(archivePath);

    expect(members).toHaveLength(2);
    const top = members.find((m) => m.zipPath === "exhibit-1.txt");
    const nested = members.find((m) => m.zipPath === "docs/exhibit-2.txt");
    expect(top?.filename).toBe("exhibit-1.txt");
    expect(top?.content.toString("utf-8")).toBe("top-level member");
    expect(nested?.filename).toBe("exhibit-2.txt");
    expect(nested?.content.toString("utf-8")).toBe("nested member");
  });

  it("deletes the archive file at archivePath once unpack succeeds, before yielding any member", async () => {
    const archivePath = await buildFixtureSevenZip({ "exhibit-1.txt": "content" });
    const extractDir = await trackedTempDir("sevenzip-extract-");

    const iterator = extractSevenZipMembers(archivePath, extractDir, DEFAULT_MAX_UNCOMPRESSED_BYTES);
    const first = await iterator.next();

    expect(first.done).toBe(false);
    await expect(sevenZip.list(archivePath)).rejects.toThrow();
  });

  it("throws for bytes that aren't a valid 7z archive, rather than returning an empty/partial result", async () => {
    const badArchivePath = join(await trackedTempDir("sevenzip-bad-"), "not-an-archive.7z");
    await writeFile(badArchivePath, "not a 7z file at all");

    await expect(collectMembers(badArchivePath)).rejects.toThrow();
  });

  it("rejects an archive whose real uncompressed contents exceed the given ceiling, without ever calling unpack", async () => {
    const archivePath = await buildFixtureSevenZip({ "exhibit-1.txt": "x".repeat(1000) });

    await expect(collectMembers(archivePath, 100)).rejects.toThrow(/uncompressed contents/);
    // unpack() never ran, so the archive file must still exist — proven by
    // list() (which reads the archive, not the extraction) still working.
    await expect(sevenZip.list(archivePath)).resolves.not.toThrow();
  });
});
