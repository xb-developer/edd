import { useEffect, useState } from "react";
import type { ApiClient } from "../api";
import type { CaseHeadingDTO } from "../types";

interface Props {
  api: ApiClient;
  onClose: () => void;
}

const EMPTY: CaseHeadingDTO = {
  claimNoLabel: "",
  preamble: [],
  courtLines: [],
  claimants: [],
  claimantsLabel: "Claimant",
  vLabel: "-v-",
  defendants: [],
  defendantsLabel: "Defendant",
};

function toText(lines: string[]): string {
  return lines.join("\n");
}

function toLines(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

export function CaseHeadingForm({ api, onClose }: Props) {
  const [heading, setHeading] = useState<CaseHeadingDTO>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .getCaseHeading()
      .then(setHeading)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [api]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const saved = await api.saveCaseHeading(heading);
      setHeading(saved);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className="case-heading-form">Loading case details…</div>;

  return (
    <form className="case-heading-form" onSubmit={handleSave}>
      <div className="case-heading-form__grid">
        <label>
          Claim number
          <input
            type="text"
            value={heading.claimNoLabel}
            onChange={(e) => setHeading({ ...heading, claimNoLabel: e.target.value })}
            placeholder="Claim No. 1234567890"
          />
        </label>

        <label>
          Preamble (optional, one line each)
          <textarea
            rows={2}
            value={toText(heading.preamble)}
            onChange={(e) => setHeading({ ...heading, preamble: toLines(e.target.value) })}
          />
        </label>

        <label>
          Court lines (one per line)
          <textarea
            rows={2}
            value={toText(heading.courtLines)}
            onChange={(e) => setHeading({ ...heading, courtLines: toLines(e.target.value) })}
            placeholder="IN THE HIGH COURT OF JUSTICE&#10;BUSINESS AND PROPERTY COURTS"
          />
        </label>

        <div className="case-heading-form__party">
          <label>
            Claimants (one per line)
            <textarea
              rows={3}
              value={toText(heading.claimants)}
              onChange={(e) => setHeading({ ...heading, claimants: toLines(e.target.value) })}
            />
          </label>
          <label>
            Claimants label
            <input
              type="text"
              value={heading.claimantsLabel}
              onChange={(e) => setHeading({ ...heading, claimantsLabel: e.target.value })}
            />
          </label>
        </div>

        <label className="case-heading-form__v-label">
          "v" separator
          <input type="text" value={heading.vLabel} onChange={(e) => setHeading({ ...heading, vLabel: e.target.value })} />
        </label>

        <div className="case-heading-form__party">
          <label>
            Defendants (one per line)
            <textarea
              rows={3}
              value={toText(heading.defendants)}
              onChange={(e) => setHeading({ ...heading, defendants: toLines(e.target.value) })}
            />
          </label>
          <label>
            Defendants label
            <input
              type="text"
              value={heading.defendantsLabel}
              onChange={(e) => setHeading({ ...heading, defendantsLabel: e.target.value })}
            />
          </label>
        </div>
      </div>

      {error && <p className="error">{error}</p>}

      <div className="case-heading-form__actions">
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="primary" disabled={saving}>
          {saving ? "Saving…" : "Save case details"}
        </button>
      </div>
    </form>
  );
}
