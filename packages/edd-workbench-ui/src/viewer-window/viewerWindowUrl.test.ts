import { describe, expect, it } from "vitest";
import { buildViewerWindowUrl, parseViewerWindowParams } from "./viewerWindowUrl.js";

describe("buildViewerWindowUrl / parseViewerWindowParams", () => {
  it("round-trips matterId/documentId/sessionId", () => {
    const url = buildViewerWindowUrl({ matterId: "matter-1", documentId: "doc-1", sessionId: "session-1" });
    const parsed = parseViewerWindowParams(url.slice(1)); // drop the leading "?", matching window.location.search's own leading "?"

    expect(parsed).toEqual({ matterId: "matter-1", documentId: "doc-1", sessionId: "session-1" });
  });

  it("round-trips with no document selected yet", () => {
    const url = buildViewerWindowUrl({ matterId: "matter-1", documentId: null, sessionId: "session-1" });
    const parsed = parseViewerWindowParams(url.slice(1));

    expect(parsed).toEqual({ matterId: "matter-1", documentId: null, sessionId: "session-1" });
  });

  it("returns null for a search string that isn't a viewer-window load at all", () => {
    expect(parseViewerWindowParams("")).toBeNull();
    expect(parseViewerWindowParams("?foo=bar")).toBeNull();
  });

  it("returns null when sessionId is missing even if matterId is present", () => {
    expect(parseViewerWindowParams("?viewerMatterId=matter-1")).toBeNull();
  });
});
