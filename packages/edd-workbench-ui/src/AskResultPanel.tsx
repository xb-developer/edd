import type { AskResultDTO } from "./types";
import { Button } from "antd";

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
    <div className="mb-6 border-t border-line pt-4">
      <h2 className="m-0 mb-2.5 text-[10.5px] font-semibold tracking-[0.08em] text-ink-soft uppercase">Answer</h2>
      <p className="m-0 mb-2.5 text-[12.5px] leading-normal whitespace-pre-wrap">{result.answer}</p>
      {result.relevantDocuments.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {result.relevantDocuments.map((doc) => (
            <li key={doc.documentId}>
              <Button type="link" size="small" className="h-auto p-0 text-left" onClick={() => onSelectDocument(doc.documentId)}>
                {doc.guid} — {doc.filename}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
