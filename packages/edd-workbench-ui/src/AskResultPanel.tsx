import type { AskResultDTO } from "./types";

export interface AskResultPanelProps {
  result: AskResultDTO;
  onSelectDocument: (documentId: string) => void;
}

/**
 * Renders below CodingPanel in the right-hand column (see MatterDetail.tsx)
 * — a separate sibling component, not folded into CodingPanel, since that
 * file is scoped to tagging concerns and this is a wholly different
 * feature (RAG Q&A) that happens to render in the same column. Nothing to
 * render at all when there's no result yet — MatterDetail only mounts this
 * once `askResult` is non-null.
 */
export function AskResultPanel({ result, onSelectDocument }: AskResultPanelProps) {
  return (
    <div className="section ask-result-panel">
      <h2 className="panel-title">Answer</h2>
      <p className="ask-answer">{result.answer}</p>
      {result.relevantDocuments.length > 0 && (
        <ul className="ask-relevant-documents">
          {result.relevantDocuments.map((doc) => (
            <li key={doc.documentId}>
              <button type="button" className="ask-relevant-document-btn" onClick={() => onSelectDocument(doc.documentId)}>
                {doc.guid} — {doc.filename}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
