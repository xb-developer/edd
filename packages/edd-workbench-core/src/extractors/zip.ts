import JSZip from "jszip";

export interface ZipMember {
  filename: string;
  /** The entry's full path within the archive (e.g. "docs/exhibit-1.pdf") — cheap provenance, same idea as pst.ts's folderPath. */
  zipPath: string;
  content: Buffer;
}

/**
 * Extracts every real (non-directory) member's bytes from a .zip archive.
 * A genuinely corrupt zip is allowed to throw — there's no honest "empty
 * but valid" metadata shape to fall back to, same contract
 * `iteratePstMessages` already has; the caller marks the container
 * `ingest_status = 'failed'` with the error recorded.
 */
export async function extractZipMembers(buffer: Buffer): Promise<ZipMember[]> {
  const zip = await JSZip.loadAsync(buffer);
  const members: ZipMember[] = [];

  for (const zipPath of Object.keys(zip.files)) {
    const entry = zip.files[zipPath];
    if (entry.dir) continue;
    const content = await entry.async("nodebuffer");
    const filename = zipPath.split("/").pop() || zipPath;
    members.push({ filename, zipPath, content });
  }

  return members;
}
