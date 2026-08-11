import { useState } from "react";
import { useBoundApi } from "../useCloudApi";
import type { AskResult } from "../types";

interface Props {
  matterId: string;
  onSelectDocumentId: (id: string) => void;
}

export function AskPanel({ matterId, onSelectDocumentId }: Props) {
  const api = useBoundApi();
  const [question, setQuestion] = useState("");
  const [result, setResult] = useState<AskResult | null>(null);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleAsk(e: React.FormEvent) {
    e.preventDefault();
    if (!question.trim()) return;
    setAsking(true);
    setError(null);
    try {
      const res = await api.ask(matterId, question.trim());
      setResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAsking(false);
    }
  }

  return (
    <div className="ask-panel">
      <h2>Ask</h2>
      <form onSubmit={handleAsk}>
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Ask a question about this matter's documents…"
          rows={3}
        />
        <button type="submit" disabled={asking}>
          {asking ? "Thinking… (can take a while on CPU)" : "Ask"}
        </button>
      </form>
      {error && <p className="error-text">{error}</p>}
      {result && (
        <div className="ask-result">
          <p className="ask-answer">{result.answer}</p>
          {result.citations.length > 0 && (
            <div className="ask-citations">
              <span className="muted">Sources:</span>
              {result.citations.map((c) => (
                <button key={c.documentId} className="citation-chip" onClick={() => onSelectDocumentId(c.documentId)}>
                  {c.guid} — {c.filename}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
