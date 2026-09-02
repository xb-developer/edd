/**
 * eml/msg documents are more usefully identified by their extracted Subject
 * line than by whatever filename they happened to arrive with — an
 * attachment with no real name of its own (e.g. a nested forwarded email)
 * would otherwise show as a synthesized placeholder like "unnamed.eml".
 */
export function displayFilename(doc: { originalFilename: string; contentTypeDetected: string; title: string | null }): string {
  const isEmail = doc.contentTypeDetected === "eml" || doc.contentTypeDetected === "msg";
  return isEmail && doc.title ? doc.title : doc.originalFilename;
}

/**
 * Strips a trailing ".<extension>" (case-insensitive) — the adjacent Type
 * column already shows the extension, so the Filename cell doesn't need to
 * repeat it. Only strips an exact trailing match, not a generic last-dot
 * split, so a subject line that happens to contain a literal "." isn't
 * mis-truncated.
 */
export function stripExtension(name: string, extension: string): string {
  if (!extension) return name;
  const suffix = `.${extension}`;
  return name.toLowerCase().endsWith(suffix.toLowerCase()) ? name.slice(0, name.length - suffix.length) : name;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function zeroPad(value: number, length: number): string {
  return String(value).padStart(length, "0");
}

/**
 * Always UTC, formatted as dd/MM/YYYY HH:mm:ss ZZ. No date library needed:
 * displaying "in UTC" makes the offset component always the literal
 * +0000, and converting an arbitrary ISO string's own timezone TO UTC is
 * exactly what Date's own getUTC* accessors already do — a real
 * conversion (not just a reformat), since `value` may carry any offset.
 */
export function formatDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  const day = zeroPad(date.getUTCDate(), 2);
  const month = zeroPad(date.getUTCMonth() + 1, 2);
  const year = date.getUTCFullYear();
  const hours = zeroPad(date.getUTCHours(), 2);
  const minutes = zeroPad(date.getUTCMinutes(), 2);
  const seconds = zeroPad(date.getUTCSeconds(), 2);
  return `${day}/${month}/${year} ${hours}:${minutes}:${seconds} +0000`;
}
