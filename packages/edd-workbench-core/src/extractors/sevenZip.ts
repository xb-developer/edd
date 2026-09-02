import { readdir, readFile, unlink } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import sevenZip from "7zip-min";

export interface SevenZipMember {
  filename: string;
  /** The entry's path within the archive, relative to the extraction root (e.g. "docs/exhibit-1.pdf") — same idea as zip.ts's own zipPath. */
  zipPath: string;
  content: Buffer;
}

// 7-Zip's `list` command reports a directory entry's attr string starting
// with "D" (e.g. "D...."), a real file's not (e.g. "....A") — used below to
// exclude directories from the uncompressed-size total. An entry with no
// attr at all (some archive formats don't report one) is deliberately
// treated as a file, not skipped — the safer direction for a size ceiling
// meant to catch a compression bomb, since undercounting is the dangerous
// mistake here, not overcounting.
function isDirectoryAttr(attr: string | undefined): boolean {
  return (attr ?? "").toUpperCase().startsWith("D");
}

/**
 * Extracts every real (non-directory, non-symlink) member's bytes from a
 * .7z archive already downloaded to `archivePath`, via `extractDir` (an
 * already-created, caller-owned temp directory — same "caller manages the
 * temp resource's lifecycle" contract pst.ts's iteratePstMessages has for
 * its own file path). Unlike zip.ts's extractZipMembers, this never
 * buffers the archive itself in memory: 7z's much higher compression
 * ratios make an in-memory buffer approach a real compression-bomb risk at
 * a much smaller input size than a zip's, so both the archive and its
 * extracted contents are handled via disk, matching pst.ts's own
 * disk-streaming precedent.
 *
 * `maxUncompressedBytes` is enforced via a `list()` call *before*
 * `unpack()` ever runs — summing every non-directory entry's reported
 * uncompressed size and failing fast if the total would exceed the
 * ceiling, converting a potential mid-extraction disk-exhaustion crash
 * into a clean, recorded failure (same philosophy as ingest.ts's own
 * PST_MAX_SIZE_BYTES comment). The archive file at `archivePath` is
 * deleted immediately after a successful `unpack()` — not deferred to the
 * caller's own cleanup — specifically to free that disk back before the
 * read-back loop below starts, since the compressed archive and the fully
 * extracted tree only need to coexist on disk for the brief unpack() call
 * itself, not for this whole generator's lifetime.
 *
 * A genuinely corrupt or encrypted-without-password archive is allowed to
 * throw — same "no honest empty-but-valid fallback" contract
 * iteratePstMessages/extractZipMembers already have; the caller marks the
 * container `ingest_status = 'failed'` with the error recorded.
 *
 * Known, accepted residual risk: 7-Zip has had real disclosed
 * path-traversal issues (crafted entry names making `unpack()` itself
 * write outside the target directory). `extractDir` must always be a
 * fresh, unpredictable directory (see ingest.ts's handleSevenZipIngest,
 * which creates it via `fs.mkdtemp`) as a partial mitigation, but this
 * module does not attempt to sandbox `unpack()` itself — out of scope for
 * this change, and a bounded risk given the worker's own architecture (a
 * single-tenant, ephemeral Fargate task with no persistent volume beyond
 * its own container).
 */
export async function* extractSevenZipMembers(
  archivePath: string,
  extractDir: string,
  maxUncompressedBytes: number,
): AsyncGenerator<SevenZipMember> {
  const listing = await sevenZip.list(archivePath);
  const uncompressedTotal = listing
    .filter((item) => !isDirectoryAttr(item.attr))
    .reduce((total, item) => total + Number(item.size ?? 0), 0);
  if (uncompressedTotal > maxUncompressedBytes) {
    throw new Error(
      `7z archive's uncompressed contents are ${uncompressedTotal} bytes, exceeding this worker's ${maxUncompressedBytes}-byte ceiling (see ingest.ts's SEVEN_ZIP_MAX_UNCOMPRESSED_BYTES)`,
    );
  }

  await sevenZip.unpack(archivePath, extractDir);
  await unlink(archivePath);

  const entries = await readdir(extractDir, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    // isFile() is false for both directories and symlinks — a malicious
    // archive's symlink must never be read through as if it were real
    // member content.
    if (!entry.isFile()) continue;
    const fullPath = join(entry.parentPath, entry.name);
    const content = await readFile(fullPath);
    const zipPath = relative(extractDir, fullPath).split(sep).join("/");
    yield { filename: entry.name, zipPath, content };
  }
}
