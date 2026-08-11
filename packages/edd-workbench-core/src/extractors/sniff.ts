const RTF_MAGIC = Buffer.from("{\\rtf");
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

/** True if `buffer` starts with RTF's literal `{\rtf` header — real RTF, not merely an extension guess. */
export function looksLikeRtf(buffer: Buffer): boolean {
  return buffer.subarray(0, RTF_MAGIC.length).equals(RTF_MAGIC);
}

/** True if `buffer` starts with a local-file-header zip signature — covers docx/xlsx/pptx/odt/ods/odp files mislabeled with a legacy extension. */
export function looksLikeZip(buffer: Buffer): boolean {
  return buffer.subarray(0, ZIP_MAGIC.length).equals(ZIP_MAGIC);
}

/**
 * Best-effort sniff for plausible UTF-8 text in the first 8KB: rejects
 * anything containing a NUL byte (binary formats almost always have one
 * early; genuine text essentially never does) and requires the vast
 * majority of bytes to be printable ASCII/whitespace or valid UTF-8
 * continuation bytes. Not a full UTF-8 validator — just enough to decide
 * "safe to extract as text" for an unrecognized extension.
 */
export function looksLikeText(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 8192);
  if (sample.length === 0) return true;
  if (sample.includes(0)) return false;

  let printable = 0;
  for (const byte of sample) {
    const isControlWhitespace = byte === 0x09 || byte === 0x0a || byte === 0x0d;
    const isPrintableAscii = byte >= 0x20 && byte <= 0x7e;
    const isUtf8Continuation = byte >= 0x80;
    if (isControlWhitespace || isPrintableAscii || isUtf8Continuation) printable++;
  }
  return printable / sample.length > 0.95;
}
