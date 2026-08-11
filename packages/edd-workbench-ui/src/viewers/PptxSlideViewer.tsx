import { useEffect, useRef, useState } from "react";

export interface PptxSlideViewerProps {
  url: string;
}

// @aiden0z/pptx-renderer runs only in a live browser DOM (see DocumentViewer's
// needsViewUrl comment) — it parses and renders directly into the container
// element handed to it, so there's no separate "extracted model" to pull
// from metadata the way docx/xlsx do. pdfjs is explicitly disabled: it's
// only used for EMF/SmartArt PDF-fallback previews, and pdfjs-dist currently
// carries a high-severity arbitrary-JS-execution advisory (GHSA-hq66-cqwq-w95j)
// this codebase deliberately keeps uninstalled from this package's tree.
export function PptxSlideViewer({ url }: PptxSlideViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let viewer: { destroy(): void } | undefined;
    setLoading(true);
    setError(null);

    (async () => {
      const { PptxViewer, RECOMMENDED_ZIP_LIMITS } = await import("@aiden0z/pptx-renderer");
      try {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`Failed to fetch presentation (${resp.status})`);
        const buffer = await resp.arrayBuffer();
        if (cancelled || !containerRef.current) return;

        viewer = await PptxViewer.open(buffer, containerRef.current, {
          zipLimits: RECOMMENDED_ZIP_LIMITS,
          pdfjs: false,
        });
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      viewer?.destroy();
    };
  }, [url]);

  return (
    <div style={{ position: "relative", width: "100%", height: "100%", overflow: "auto" }}>
      {loading && <p className="empty-note">Loading slides…</p>}
      {error && <div className="preview-unsupported">{error}</div>}
      <div ref={containerRef} style={{ width: "100%" }} />
    </div>
  );
}
