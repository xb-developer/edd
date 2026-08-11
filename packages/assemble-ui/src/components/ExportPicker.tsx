import { useEffect, useRef, useState } from "react";
import type { BundleDTO } from "../types";

interface Props {
  bundles: BundleDTO[];
  onExport: (bundleIds: string[]) => void;
}

/** Dropdown next to the export button letting the user tick which bundle sets to include — defaults to all of them every time it's opened, matching the export's previous "everything" behavior unless the user deliberately narrows it. */
export function ExportPicker({ bundles, onExport }: Props) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  function toggleOpen() {
    if (!open) setSelected(new Set(bundles.map((b) => b.id)));
    setOpen((v) => !v);
  }

  function toggleBundle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected((prev) => (prev.size === bundles.length ? new Set() : new Set(bundles.map((b) => b.id))));
  }

  function handleExportClick() {
    onExport([...selected]);
    setOpen(false);
  }

  return (
    <div className="export-picker" ref={containerRef}>
      <button className="primary" onClick={toggleOpen}>
        Export bundle…
      </button>
      {open && (
        <div className="export-picker__dropdown">
          <div className="export-picker__header">
            <span>Bundles to export</span>
            <label className="export-picker__select-all">
              <input
                type="checkbox"
                checked={bundles.length > 0 && selected.size === bundles.length}
                onChange={toggleAll}
              />
              All
            </label>
          </div>
          {bundles.length === 0 && <p className="muted small">No bundles yet.</p>}
          <ul className="export-picker__list">
            {bundles.map((b) => (
              <li key={b.id}>
                <label>
                  <input type="checkbox" checked={selected.has(b.id)} onChange={() => toggleBundle(b.id)} />
                  {b.label ? `${b.label} — ` : ""}
                  {b.title || "(untitled bundle)"}
                </label>
              </li>
            ))}
          </ul>
          <button className="primary small" disabled={selected.size === 0} onClick={handleExportClick}>
            Export {selected.size || ""} bundle{selected.size === 1 ? "" : "s"}
          </button>
        </div>
      )}
    </div>
  );
}
