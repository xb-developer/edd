import { useState } from "react";
import { api } from "../api";

interface Props {
  onClose: () => void;
  onSelectGuid: (guid: string) => void;
}

interface AskResult {
  answer: string;
  sources: Array<{ guid: string; originalName: string; snippet: string }>;
}

function renderAnswer(answer: string, onSelectGuid: (guid: string) => void) {
  const parts = answer.split(/(\[\d{6}\])/g);
  return parts.map((part, i) => {
    const m = part.match(/^\[(\d{6})\]$/);
    if (!m) return <span key={i}>{part}</span>;
    return (
      <button
        key={i}
        className="chip"
        style={{ background: "var(--navy-soft)", color: "var(--navy)", cursor: "pointer", border: "none" }}
        onClick={() => onSelectGuid(m[1])}
      >
        {part}
      </button>
    );
  });
}

export function AskPanel({ onClose, onSelectGuid }: Props) {
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AskResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const q = question.trim();
    if (!q || loading) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await api.ask(q);
      setResult(res);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="ask-overlay" onClick={onClose}>
      <div className="ask-panel" onClick={(e) => e.stopPropagation()}>
        <div className="ask-panel-head">
          <h2 className="panel-title" style={{ margin: 0 }}>
            Ask the register
          </h2>
          <button className="row-delete-btn" onClick={onClose} title="Close">
            ×
          </button>
        </div>

        <div className="export-hint" style={{ marginBottom: 10 }}>
          Runs entirely on your local Ollama model — nothing leaves this machine. Answers are grounded only in the
          documents you've imported; each claim cites the GUID it came from.
        </div>

        <div className="custom-tag-row">
          <input
            placeholder="Ask a question about these documents…"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            disabled={loading}
            autoFocus
          />
          <button onClick={submit} disabled={loading || !question.trim()}>
            {loading ? "Thinking…" : "Ask"}
          </button>
        </div>

        {error && (
          <div className="bulk-note" style={{ marginTop: 12 }}>
            {error}
          </div>
        )}

        {loading && (
          <div className="empty-note" style={{ marginTop: 12 }}>
            Searching the indexed documents and generating a grounded answer. This machine has no GPU, so a full
            answer can take several minutes — please wait rather than resubmitting.
          </div>
        )}

        {result && (
          <div style={{ marginTop: 16 }}>
            <div className="preview-html">{renderAnswer(result.answer, onSelectGuid)}</div>

            {result.sources.length > 0 && (
              <>
                <h3 className="pane-title" style={{ margin: "14px 0 8px", padding: 0, border: "none" }}>
                  Sources
                </h3>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {result.sources.map((s) => (
                    <button
                      key={s.guid}
                      className="matter-list-item"
                      onClick={() => onSelectGuid(s.guid)}
                      style={{ textAlign: "left" }}
                    >
                      <span>
                        <span className="guid-badge-sm">{s.guid}</span> <span className="ref-name">{s.originalName}</span>
                        <div className="muted" style={{ fontWeight: 400, fontSize: 11, marginTop: 4 }}>
                          {s.snippet}…
                        </div>
                      </span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
