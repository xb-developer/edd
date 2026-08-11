import type { PDFFont } from "pdf-lib";

/**
 * Strips (or, if a non-empty fallback is given, replaces) any character a
 * given font's encoding can't represent, so a bad character in a document
 * title (real-world titles carry messy/malformed metadata — control
 * characters, stray NULs) can't throw and abort an entire export. Defaults
 * to dropping rather than substituting a visible placeholder: the offending
 * characters are almost always invisible control characters, so a visible
 * "?" would introduce a new artifact rather than just removing one. Checked
 * per-character via the font itself (a cheap widthOfTextAtSize probe) rather
 * than hand-maintaining a WinAnsi character table, so it stays correct if the
 * standard font's supported set ever changes.
 */
export function sanitizeForFont(text: string, font: PDFFont, fallback = ""): string {
  let result = "";
  let changed = false;
  for (const char of text) {
    try {
      font.widthOfTextAtSize(char, 1);
      result += char;
    } catch {
      result += fallback;
      changed = true;
    }
  }
  return changed ? result : text;
}
