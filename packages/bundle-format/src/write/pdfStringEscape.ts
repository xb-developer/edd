/**
 * Escapes backslashes and parentheses for use inside a PDF literal string
 * (`(...)`). pdf-lib's own `PDFString.of` deliberately does not do this —
 * the PDF spec allows unescaped parens as long as they're balanced, and
 * pdf-lib leaves that responsibility to the caller. Real bundle document
 * titles aren't guaranteed to be balanced (one real bundle had a title
 * literally ending in an unmatched "(", e.g. from a truncated filename) —
 * writing that unescaped corrupts every object after it, since the PDF
 * reader's paren-nesting counter never returns to zero. Always escaping
 * (whether or not the input happens to already be balanced) is unconditionally
 * valid per the PDF spec, so this is safe to apply to every string, not just
 * ones known to be unbalanced.
 */
export function escapePdfString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}
