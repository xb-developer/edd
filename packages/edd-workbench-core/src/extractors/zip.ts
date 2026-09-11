import JSZip from "jszip";

export interface ZipMember {
  filename: string;
  /** The entry's full path within the archive (e.g. "docs/exhibit-1.pdf") — cheap provenance, same idea as pst.ts's folderPath. */
  zipPath: string;
  content: Buffer;
}

/**
 * JSZip's public API exposes no uncompressed size, but every loaded entry
 * carries one internally. Read defensively: a JSZip upgrade that renames
 * this is a silently-skipped precheck, not a crash, and the running total
 * in the loop below still bounds the many-small-members case.
 */
function declaredUncompressedSize(entry: unknown): number | null {
  const data = (entry as { _data?: { uncompressedSize?: unknown } })._data;
  return typeof data?.uncompressedSize === "number" ? data.uncompressedSize : null;
}

/**
 * Yields every real (non-directory) member's bytes from a .zip archive, one
 * at a time.
 *
 * A generator, not an array, because the array form held EVERY member's
 * decompressed bytes in memory simultaneously — and the caller's only
 * guard (containerExpansion.ts's ZIP_MAX_SIZE_BYTES) caps the *compressed*
 * archive at 2 GiB, which at a routine 10:1 text ratio is ~20 GiB of live
 * Buffers against a worker sized far below that. Streaming bounds peak
 * memory to the compressed archive plus the single largest member.
 * expandMembers already accepts an AsyncIterable (the 7z and mbox paths
 * are generators for the same reason), so nothing downstream changes.
 *
 * `maxUncompressedBytes` closes the remaining gap, mirroring the split
 * compressed/uncompressed ceilings sevenZip.ts already has: it's checked
 * per entry BEFORE decompressing (catching one huge member) and as a
 * running total (catching many small ones). Same "convert a potential
 * OOM-kill into a clean recorded failure" reasoning as every other
 * container ceiling.
 *
 * A genuinely corrupt zip is allowed to throw — there's no honest "empty
 * but valid" metadata shape to fall back to, same contract
 * `iteratePstMessages`/`extractSevenZipMembers` already have; the caller
 * marks the container `ingest_status = 'failed'` with the error recorded.
 */
export async function* extractZipMembers(buffer: Buffer, maxUncompressedBytes: number): AsyncGenerator<ZipMember> {
  const zip = await JSZip.loadAsync(buffer);
  let uncompressedTotal = 0;

  for (const zipPath of Object.keys(zip.files)) {
    const entry = zip.files[zipPath];
    if (entry.dir) continue;

    const declared = declaredUncompressedSize(entry);
    if (declared !== null && uncompressedTotal + declared > maxUncompressedBytes) {
      throw new Error(
        `Zip archive's uncompressed contents exceed this worker's ${maxUncompressedBytes}-byte ceiling (see containerExpansion.ts's ZIP_MAX_UNCOMPRESSED_BYTES)`,
      );
    }

    const content = await entry.async("nodebuffer");
    uncompressedTotal += content.byteLength;
    if (uncompressedTotal > maxUncompressedBytes) {
      throw new Error(
        `Zip archive's uncompressed contents are at least ${uncompressedTotal} bytes, exceeding this worker's ${maxUncompressedBytes}-byte ceiling (see containerExpansion.ts's ZIP_MAX_UNCOMPRESSED_BYTES)`,
      );
    }

    const filename = zipPath.split("/").pop() || zipPath;
    yield { filename, zipPath, content };
  }
}
