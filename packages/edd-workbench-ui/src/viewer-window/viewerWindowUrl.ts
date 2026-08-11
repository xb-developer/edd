export interface ViewerWindowParams {
  matterId: string;
  documentId: string | null;
  sessionId: string;
}

/**
 * Builds a relative URL (query string only) for the pop-out viewer window —
 * relative, not absolute, and not a new route, so opening it needs no
 * CloudFront change: `/` already serves `index.html` and already accepts
 * query strings. `window.open()` resolves a relative URL against the
 * current document's location the same way a plain link would, so there's
 * no need to depend on `window.location.origin` here — keeping this pure
 * and testable outside a browser.
 */
export function buildViewerWindowUrl(params: ViewerWindowParams): string {
  const search = new URLSearchParams({ viewerMatterId: params.matterId, viewerSessionId: params.sessionId });
  if (params.documentId) search.set("viewerDocumentId", params.documentId);
  return `?${search.toString()}`;
}

/** Parses `window.location.search` back into viewer params, or null if this isn't a viewer-window load at all. */
export function parseViewerWindowParams(search: string): ViewerWindowParams | null {
  const params = new URLSearchParams(search);
  const matterId = params.get("viewerMatterId");
  const sessionId = params.get("viewerSessionId");
  if (!matterId || !sessionId) return null;
  return { matterId, sessionId, documentId: params.get("viewerDocumentId") };
}
