import { useEffect, useRef, useState } from "react";

// The stored value is always a plain free-text string end to end (matches
// how "date" is treated everywhere else in the pipeline — an opaque display
// string, never parsed) — this picker is a convenience that WRITES into that
// same free-text field, it doesn't replace it. Typing anything directly
// (e.g. "No Date", or a range like "26 March 2026 - 31 March 2026") still
// works exactly as before.

type FormatId = "long" | "shortYear" | "dotted" | "slash";

const MONTHS_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

const FORMATS: { id: FormatId; label: string; format: (y: number, m: number, d: number) => string }[] = [
  { id: "long", label: "26 March 2026", format: (y, m, d) => `${d} ${MONTHS_LONG[m - 1]} ${y}` },
  { id: "shortYear", label: "26 Mar 26", format: (y, m, d) => `${d} ${MONTHS_SHORT[m - 1]} ${String(y).slice(-2)}` },
  { id: "dotted", label: "26.3.26", format: (y, m, d) => `${pad2(d)}.${m}.${String(y).slice(-2)}` },
  { id: "slash", label: "26/03/2026", format: (y, m, d) => `${pad2(d)}/${pad2(m)}/${y}` },
];

interface Props {
  /** Current free-text value (may be a picker-formatted date, a range, "No Date", anything). */
  value: string;
  /** Called on every local edit (typing or a picker selection). */
  onChange: (value: string) => void;
  /** Called when a value should actually be persisted (text blur, or immediately on a picker selection). */
  onCommit: (value: string) => void;
}

export function DateEditor({ value, onChange, onCommit }: Props) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [formatId, setFormatId] = useState<FormatId>("long");
  const [pickedIso, setPickedIso] = useState("");
  const containerRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!pickerOpen) return;
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setPickerOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [pickerOpen]);

  function apply(iso: string, fmt: FormatId) {
    if (!iso) return;
    const [y, m, d] = iso.split("-").map(Number);
    const formatted = FORMATS.find((f) => f.id === fmt)!.format(y, m, d);
    onChange(formatted);
    onCommit(formatted);
  }

  return (
    <span className="date-editor" ref={containerRef}>
      <input
        type="text"
        className="doc-date-input"
        placeholder="Date"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={(e) => onCommit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
      />
      <button
        type="button"
        className="date-editor__toggle"
        title="Pick a date"
        onClick={() => setPickerOpen((v) => !v)}
      >
        📅
      </button>
      {pickerOpen && (
        <span className="date-editor__picker">
          <input
            type="date"
            value={pickedIso}
            onChange={(e) => {
              setPickedIso(e.target.value);
              apply(e.target.value, formatId);
            }}
          />
          <select
            value={formatId}
            onChange={(e) => {
              const fmt = e.target.value as FormatId;
              setFormatId(fmt);
              if (pickedIso) apply(pickedIso, fmt);
            }}
          >
            {FORMATS.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </select>
        </span>
      )}
    </span>
  );
}
