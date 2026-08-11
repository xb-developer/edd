const PAGE_SUFFIX_RE = /\s*\(page [^)]*\)\s*$/i;
const INDEX_TITLE_RE = /^(null\.\s*)?index\b/i;
const LEADING_NUMBER_RE = /^\s*\d+\.\s*/;
const NUMERIC_DATE_RE = /\s+-\s+(\d{1,2}\/\d{1,2}\/\d{4})\s*$/;
const MONTHS = "January|February|March|April|May|June|July|August|September|October|November|December";
const ORDINAL_DATE_RE = new RegExp(
  `\\s+-\\s+(\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MONTHS})\\s+\\d{4})\\s*$`,
  "i",
);

// A real Court of Appeal bundle set has been seen with no "- Date" suffix
// convention at all — instead each document's title embeds its date
// mid-string via "... dated <date> ..." (e.g. "Order of HHJ Davies dated 10
// June 2021 (Case Management - Sale Process) (Order 2)"), with the date
// format varying even across bundles in the same set — day + full or
// abbreviated month name ("26 May 2021", "26 Mar 2021"), the same with '/'
// or '-' separators ("26/Mar/2021"), or plain numeric ("26/05/2021",
// "26/05/21"). Matched only when anchored on the word "dated" — searching
// for a bare date pattern anywhere, with no anchor, risks matching case
// numbers or other incidental digits in a title.
const ABBR_MONTHS = "Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec";
const NAMED_DATE = `\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MONTHS}|${ABBR_MONTHS})\\.?\\s+\\d{4}`;
const SLASH_NAMED_DATE = `\\d{1,2}[/-](?:${ABBR_MONTHS})[/-]\\d{2,4}`;
const NUMERIC_SLASH_DATE = `\\d{1,2}[/-]\\d{1,2}[/-]\\d{2,4}`;
const DATED_PHRASE_RE = new RegExp(`\\bdated\\s+(${NAMED_DATE}|${SLASH_NAMED_DATE}|${NUMERIC_SLASH_DATE})`, "i");

export function isIndexTitle(title: string): boolean {
  return INDEX_TITLE_RE.test(title.trim());
}

export function stripPageSuffix(title: string): string {
  return title.replace(PAGE_SUFFIX_RE, "");
}

export interface CleanedTitle {
  name: string;
  date: string | null;
}

/**
 * Mirrors the write side's title convention in reverse:
 * "N. Name - Date (page X-Y)" -> { name: "Name", date: "Date" }. Falls back
 * to the "... dated <date> ..." mid-title convention (see DATED_PHRASE_RE)
 * when neither suffix form matches — a real bundle has been seen with no
 * "- Date" suffix at all.
 */
export function cleanDocumentTitle(rawTitle: string): CleanedTitle {
  const withoutPageSuffix = stripPageSuffix(rawTitle).trim();
  const withoutLeadingNumber = withoutPageSuffix.replace(LEADING_NUMBER_RE, "");

  const numericMatch = withoutLeadingNumber.match(NUMERIC_DATE_RE);
  if (numericMatch && numericMatch.index !== undefined) {
    return { name: withoutLeadingNumber.slice(0, numericMatch.index).trim(), date: numericMatch[1] };
  }

  const ordinalMatch = withoutLeadingNumber.match(ORDINAL_DATE_RE);
  if (ordinalMatch && ordinalMatch.index !== undefined) {
    return { name: withoutLeadingNumber.slice(0, ordinalMatch.index).trim(), date: ordinalMatch[1] };
  }

  const datedMatch = withoutLeadingNumber.match(DATED_PHRASE_RE);
  if (datedMatch && datedMatch.index !== undefined) {
    const name = (
      withoutLeadingNumber.slice(0, datedMatch.index) + withoutLeadingNumber.slice(datedMatch.index + datedMatch[0].length)
    ).replace(/\s{2,}/g, " ");
    return { name: name.trim(), date: datedMatch[1] };
  }

  return { name: withoutLeadingNumber.trim(), date: null };
}
