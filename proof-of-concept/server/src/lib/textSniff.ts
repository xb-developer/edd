// Real-world files with a ".doc" extension are not reliably genuine legacy
// OLE2 Word documents — RTF content saved/exported with a .doc extension is
// common (confirmed against a real file: `word-extractor` correctly refuses
// it since it isn't OLE2 at all). Sniffing the actual magic bytes routes to
// the right extractor regardless of what the extension claims.
export function looksLikeRtf(buf: Buffer): boolean {
  return buf.subarray(0, 5).toString("ascii") === "{\\rtf";
}

// A ".doc" that's actually a renamed .docx (zip-based) is the other common
// mislabeling case.
export function looksLikeZip(buf: Buffer): boolean {
  return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
}

// Heuristic: sample the first few KB and reject anything that looks binary
// (a NUL byte, or a high proportion of control characters).
export function looksLikeText(buf: Buffer): boolean {
  const sample = buf.subarray(0, 8192);
  if (sample.length === 0) return true;
  let controlBytes = 0;
  for (const byte of sample) {
    if (byte === 0) return false;
    if (byte < 9 || (byte > 13 && byte < 32)) controlBytes++;
  }
  return controlBytes / sample.length <= 0.05;
}
