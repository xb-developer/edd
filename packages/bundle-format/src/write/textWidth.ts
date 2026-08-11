import { Font, Encodings } from "@pdf-lib/standard-fonts";

// Real AFM glyph-width data, loaded synchronously — no embedded PDFDocument
// needed, so this stays usable from the pure domain layer (buildCountingRows
// runs before any PDFDocument exists). Matches the actual font indexRender.ts
// draws document-name text with (Helvetica).
const HELVETICA = Font.load("Helvetica");

// Fallback for any character outside WinAnsi's supported set — close to
// Helvetica's own average glyph width (in 1/1000 em units), so an unusual
// character doesn't silently skew wrapping decisions one way or the other.
const AVERAGE_GLYPH_WIDTH = 550;

/**
 * Real rendered width, in points, of `text` at `size` — measured from actual
 * glyph metrics rather than assuming an average character width. Character-
 * count-based wrapping under-wraps long runs of uppercase letters/digits/
 * underscores (e.g. filenames used verbatim as document titles, with no
 * spaces to break on), since those render wider per character than typical
 * mixed-case prose; measuring real widths fixes that generally instead of
 * re-tuning a fragile constant (ported from Stratum's build history, where
 * this was found the hard way).
 */
export function measureText(text: string, size: number): number {
  let units = 0;
  for (const char of text) {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined) continue;
    let width: number | undefined;
    try {
      const { name } = Encodings.WinAnsi.encodeUnicodeCodePoint(codePoint);
      width = HELVETICA.getWidthOfGlyph(name) ?? undefined;
    } catch {
      width = undefined;
    }
    units += width ?? AVERAGE_GLYPH_WIDTH;
  }
  return (units / 1000) * size;
}
