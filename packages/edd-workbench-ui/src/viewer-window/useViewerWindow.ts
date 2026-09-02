import { useCallback, useEffect, useRef, useState } from "react";
import { buildViewerWindowUrl } from "./viewerWindowUrl.js";
import { openViewerChannel, postViewerMessage, subscribeToViewerChannel } from "./viewerChannel.js";
import { transitionPopoutState, type PopoutAction, type PopoutState } from "./popoutState.js";

const CLOSING_DEBOUNCE_MS = 1500;

// Document Picture-in-Picture (Chrome/Edge 116+) has no typings in this
// repo's TypeScript lib.dom.d.ts. A global `interface Window` ambient
// augmentation only applies within whichever tsconfig's own `include`
// scope compiles the file that declares it — it does NOT propagate across
// a package boundary into a consumer app's own build (confirmed: this
// package's isolated `tsc --noEmit` passed with a global augmentation
// file, but `apps/edd-workbench/client`'s build — a different tsconfig,
// different `include` root — failed on the exact same property access).
// A local typed accessor via a cast sidesteps that entirely and works
// identically regardless of which tsconfig compiles this file.
interface DocumentPictureInPictureOptions {
  width?: number;
  height?: number;
}

interface DocumentPictureInPictureApi {
  readonly window: Window | null;
  requestWindow(options?: DocumentPictureInPictureOptions): Promise<Window>;
}

function getDocumentPictureInPicture(): DocumentPictureInPictureApi | undefined {
  return (window as unknown as { documentPictureInPicture?: DocumentPictureInPictureApi }).documentPictureInPicture;
}

function sessionStorageKey(matterId: string): string {
  return `edd-workbench:viewer-session:${matterId}`;
}

function openFlagKey(matterId: string): string {
  return `edd-workbench:viewer-open:${matterId}`;
}

function getOrCreateSessionId(matterId: string): string {
  const key = sessionStorageKey(matterId);
  const existing = sessionStorage.getItem(key);
  if (existing) return existing;
  const created = crypto.randomUUID();
  sessionStorage.setItem(key, created);
  return created;
}

// The PiP document starts completely blank — no stylesheets carry over on
// their own. Cloning the <link> element (not inlining its cssRules) matters
// specifically for @fontsource's self-hosted fonts: their @font-face url()s
// resolve relative to the *stylesheet's own* URL, so text built from
// cssRules and stuffed into a <style> would resolve those url()s against
// the PiP document's (blank) location instead and 404. Inline <style>
// sheets (Vite dev, or any future <style> tag) have no separate URL to
// resolve against, so inlining their rules is safe.
function copyStylesInto(pipDocument: Document): void {
  for (const sheet of Array.from(document.styleSheets)) {
    const owner = sheet.ownerNode;
    if (owner instanceof HTMLLinkElement) {
      pipDocument.head.append(owner.cloneNode(true));
      continue;
    }
    try {
      const style = pipDocument.createElement("style");
      style.textContent = Array.from(sheet.cssRules)
        .map((rule) => rule.cssText)
        .join("\n");
      pipDocument.head.append(style);
    } catch {
      // A cross-origin stylesheet's cssRules throws a SecurityError — none
      // exist in this app today (self-hosted fonts, one origin), but this
      // must not crash the whole pop-out if one is ever added.
    }
  }
}

/**
 * Closes a matter's pop-out viewer window (if one is open) from OUTSIDE the
 * hook's own component instance — e.g. on logout, where the workspace shell
 * has no access to `useViewerWindow`'s internal `windowHandleRef` (that's
 * private to whichever `MatterDetail` mount owns it). Uses the same
 * `BroadcastChannel`-based close the hook's own `closeWindowAndNotify`
 * relies on, which already tolerates a stale/lost `Window` handle (see this
 * file's own unmount-cleanup comment) — so no direct handle is needed here
 * either. Also clears the matter's own sessionStorage keys, so a logout
 * genuinely leaves no client-side trace behind, not just a closed window.
 *
 * PiP mode isn't reachable this way (it shares the opener's JS realm, with
 * no broadcast channel involved at all) — acceptable here since PiP state
 * is never persisted across a reload anyway (see this hook's own doc
 * comment), so it carries no residual client-side data to clear regardless.
 */
export function closeViewerWindowForMatter(matterId: string): void {
  const sessionId = sessionStorage.getItem(sessionStorageKey(matterId));
  sessionStorage.removeItem(sessionStorageKey(matterId));
  sessionStorage.removeItem(openFlagKey(matterId));
  if (!sessionId) return;
  const channel = openViewerChannel();
  postViewerMessage(channel, { type: "close", sessionId });
  channel.close();
}

export interface UseViewerWindowResult {
  state: PopoutState;
  /** Renamed from popupBlockedError — a PiP rejection is virtually always "not called synchronously in a user gesture," not a popup-blocker setting, so the old copy would be actively misleading for that path. */
  popOutError: string | null;
  popOut: (documentId: string | null) => void;
  /** Feature-detected once — true only in Chromium 116+. Callers should hide the "Float on top" button entirely when this is false rather than showing it disabled, since there's no fallback behavior to offer. */
  pipSupported: boolean;
  popOutPiP: () => Promise<void>;
  /** Portal target inside the PiP window's own document — non-null only while state === "pip". Render via `createPortal(<...>, pipContainer)`. */
  pipContainer: HTMLDivElement | null;
  dockBack: () => void;
  /**
   * A real pop-out window has no OS-level "always on top" the way PiP does
   * — clicking anywhere in the main window (including re-selecting the
   * row that's already selected, which doesn't itself change
   * selectedDocumentId) naturally gives the main window focus and drops
   * the pop-out behind it. Callers should call this from the table row's
   * own onClick, alongside setSelectedDocumentId, so every row click hands
   * focus back to the pop-out — not just ones that change the selection
   * (those already get it from the selectedDocumentId effect below too;
   * calling this again there is harmless).
   */
  focusPopout: () => void;
}

/**
 * Owns the pop-out viewer window's lifecycle for one matter — two
 * genuinely different mechanisms sharing one hook:
 *
 * 1. `popOut()`/`"open"` — a real separate page load via `window.open()`,
 *    synced with a `BroadcastChannel` (see viewerChannel.ts/popoutState.ts)
 *    because it's a different JS realm entirely. Works in every browser,
 *    no always-on-top.
 * 2. `popOutPiP()`/`"pip"` — the real Document Picture-in-Picture API
 *    (Chrome/Edge 116+ only). Its window shares this same JS realm/React
 *    tree, so `pipContainer` is just a `createPortal` target — there is
 *    nothing to broadcast, and the BroadcastChannel machinery above is
 *    completely unused on this path. True OS-level always-on-top, but
 *    Chromium-only; `pipSupported` feature-detects it.
 *
 * PiP state is deliberately NOT persisted to sessionStorage the way the
 * "open" flag is — a reloaded main tab has no safe way to resume a "pip"
 * state (no second page to send a `hello` resync, and the browser
 * auto-closes the real PiP window the instant the opener reloads anyway),
 * so it always starts fresh at `docked` on mount.
 *
 * No automated test covers this hook directly — this project has no React
 * component-test harness (no jsdom/testing-library anywhere in the
 * monorepo), and window-opening/focus/auth/PiP behavior specifically has no
 * meaningful local substitute the way Postgres/S3/SQS do. `popoutState.ts`
 * carries the actual decision logic and is fully unit-tested; this file is
 * the thin, manually-verified glue around it (see the migration plan's
 * verification section for the exact manual browser checks — including a
 * `.pptx` document opened in PiP specifically, the one flagged risk).
 */
export function useViewerWindow(matterId: string, selectedDocumentId: string | null): UseViewerWindowResult {
  const sessionIdRef = useRef<string | null>(null);
  if (sessionIdRef.current === null) sessionIdRef.current = getOrCreateSessionId(matterId);
  const sessionId = sessionIdRef.current;

  const [state, setState] = useState<PopoutState>(() => (sessionStorage.getItem(openFlagKey(matterId)) === "1" ? "open" : "docked"));
  const [popOutError, setPopOutError] = useState<string | null>(null);
  const [pipContainer, setPipContainer] = useState<HTMLDivElement | null>(null);
  const windowHandleRef = useRef<Window | null>(null);
  const pipWindowRef = useRef<Window | null>(null);
  const closingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectedDocumentIdRef = useRef(selectedDocumentId);
  selectedDocumentIdRef.current = selectedDocumentId;
  const stateRef = useRef(state);
  stateRef.current = state;

  const pipSupported = typeof window !== "undefined" && "documentPictureInPicture" in window;

  const applyTransition = useCallback(
    (action: PopoutAction) => {
      setState((current) => {
        const result = transitionPopoutState(current, action);

        if (result.effect === "arm-closing-timer") {
          closingTimerRef.current = setTimeout(() => applyTransition({ type: "CLOSING_TIMEOUT_FIRED" }), CLOSING_DEBOUNCE_MS);
        } else if (result.effect === "cancel-closing-timer" && closingTimerRef.current) {
          clearTimeout(closingTimerRef.current);
          closingTimerRef.current = null;
        }

        // Only the window.open() path persists a resume-on-reload flag —
        // see this hook's own doc comment for why "pip" deliberately never
        // does.
        if (result.state === "open") sessionStorage.setItem(openFlagKey(matterId), "1");
        else sessionStorage.removeItem(openFlagKey(matterId));

        return result.state;
      });
    },
    [matterId],
  );

  useEffect(() => {
    const channel = openViewerChannel();
    const unsubscribe = subscribeToViewerChannel(channel, sessionId, (message) => {
      if (message.type === "hello") {
        applyTransition({ type: "HELLO_RECEIVED" });
        // Resync: a (re)mounted viewer window doesn't know the current
        // selection yet, and it fetches the document itself rather than
        // receiving it over the channel (avoids pushing potentially-large
        // metadata blobs through structured-clone, and stays correct once
        // tag state is real server state instead of the still-mocked
        // per-tab map it is today).
        postViewerMessage(channel, { type: "select", sessionId, matterId, documentId: selectedDocumentIdRef.current });
      } else if (message.type === "closing") {
        applyTransition({ type: "CLOSING_RECEIVED" });
      }
    });

    return () => {
      unsubscribe();
      channel.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matterId, sessionId, applyTransition]);

  // Selection changes while a viewer is open get broadcast so it updates —
  // the effect above only handles the *viewer's* incoming messages, this
  // handles the main window's outgoing ones. Only relevant to the
  // window.open() path — PiP shares this same React tree, so a selection
  // change just re-renders whatever's inside pipContainer directly, no
  // channel involved.
  //
  // Also re-focuses the pop-out here — clicking a row in the main window's
  // table naturally gives the MAIN window focus as an ordinary side effect
  // of the click, which would otherwise drop the pop-out behind it. A
  // regular window has no OS-level "always on top" the way a real PiP
  // window does, so this is the closest practical equivalent: immediately
  // after the row-selection that just fired is processed, hand focus back
  // to the pop-out so it's the one left on top, now showing that selection.
  useEffect(() => {
    if (state !== "open") return;
    const channel = openViewerChannel();
    postViewerMessage(channel, { type: "select", sessionId, matterId, documentId: selectedDocumentId });
    channel.close();
    windowHandleRef.current?.focus();
  }, [state, sessionId, matterId, selectedDocumentId]);

  const closeWindowAndNotify = useCallback(() => {
    windowHandleRef.current?.close();
    windowHandleRef.current = null;
    const channel = openViewerChannel();
    postViewerMessage(channel, { type: "close", sessionId });
    channel.close();
  }, [sessionId]);

  const popOut = useCallback(
    (documentId: string | null) => {
      if (state === "open" && windowHandleRef.current && !windowHandleRef.current.closed) {
        // moveTop()-style behavior isn't available for cross-window focus in
        // a standards browser the way Electron's BrowserWindow offers it —
        // `.focus()` is the closest equivalent, used only for this explicit
        // user action, never on ordinary selection changes (see the
        // migration plan: stealing focus on every Prev/Next click would be
        // actively annoying, not helpful).
        windowHandleRef.current.focus();
        return;
      }

      setPopOutError(null);
      // Called synchronously in the click handler, no `await` first — an
      // awaited token fetch or similar before this call is a real, easy way
      // to trigger the popup blocker.
      // availHeight (not the raw screen.height) excludes the OS taskbar/
      // chrome — the real usable height, matching the PiP path's own
      // requestWindow height below. Width stays at the same 420 the PiP
      // path already uses; only height was asked for.
      const handle = window.open(
        buildViewerWindowUrl({ matterId, documentId, sessionId }),
        "edd-workbench-viewer",
        `width=420,height=${window.screen.availHeight}`,
      );
      if (!handle) {
        setPopOutError("Your browser blocked the pop-out window. Allow pop-ups for this site and try again.");
        return;
      }

      windowHandleRef.current = handle;
      applyTransition({ type: "POP_OUT_REQUESTED" });
    },
    [state, matterId, sessionId, applyTransition],
  );

  const popOutPiP = useCallback(async () => {
    const pip = getDocumentPictureInPicture();
    if (!pipSupported || !pip) return;
    if (pip.window) return; // already open — it's already floating, nothing to focus

    setPopOutError(null);
    try {
      // Same synchronous-user-gesture constraint as window.open() above —
      // no await before this call. availHeight (not screen.height) is the
      // real usable height, excluding the OS taskbar/chrome — same
      // reasoning as the window.open() fallback below.
      const pipWindow = await pip.requestWindow({ width: 420, height: window.screen.availHeight });
      // requestWindow's own size options are only a hint Chrome doesn't
      // always honor exactly (PiP windows have historically clamped to a
      // smaller default) — an explicit resizeTo() on the real returned
      // window is meant to force the same full-height result window.open()
      // already gets below. Calling it immediately (in the same tick
      // requestWindow resolves) turned out to have no effect — Chrome
      // appears to still be settling the window's own initial placement at
      // that point and silently ignores the resize. Deferred a couple of
      // frames so it runs after that initial layout has actually finished.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          pipWindow.resizeTo(420, window.screen.availHeight);
        });
      });
      pipWindowRef.current = pipWindow;
      copyStylesInto(pipWindow.document);
      pipWindow.document.body.className = "viewer-window";
      const container = pipWindow.document.createElement("div");
      pipWindow.document.body.append(container);
      setPipContainer(container);

      pipWindow.addEventListener("pagehide", () => {
        pipWindowRef.current = null;
        setPipContainer(null);
        applyTransition({ type: "PIP_CLOSED" });
      });

      applyTransition({ type: "PIP_OPENED" });
    } catch {
      setPopOutError("Couldn't open the floating viewer — try clicking the button again (it must run directly from the click).");
    }
  }, [pipSupported, applyTransition]);

  const dockBack = useCallback(() => {
    if (stateRef.current === "pip") {
      pipWindowRef.current?.close();
      pipWindowRef.current = null;
      setPipContainer(null);
    } else {
      closeWindowAndNotify();
    }
    applyTransition({ type: "DOCK_BACK_REQUESTED" });
  }, [closeWindowAndNotify, applyTransition]);

  // Leaving this matter (unmount) or switching to a different one must not
  // leave an orphaned viewer window (either kind) showing a document from a
  // matter the user is no longer looking at. Checked via a ref, not `state`
  // directly — this effect only re-runs when `matterId` changes, so its
  // cleanup closure would otherwise see whatever `state` was at mount time,
  // not the current value. Guarding the "open" branch on `state === "open"`
  // rather than the handle's presence matters specifically for the
  // post-reload case: the real popped-out window (if still alive) is
  // listening on the channel by sessionId regardless of whether this tab
  // still holds a live `Window` handle for it, so the broadcast still
  // reaches and closes it even when `windowHandleRef.current` was lost
  // across a reload. PiP has no such reload-survival story (see this
  // hook's own doc comment), so its cleanup only ever needs the live ref.
  useEffect(() => {
    return () => {
      if (stateRef.current === "open") closeWindowAndNotify();
      else if (stateRef.current === "pip") pipWindowRef.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matterId]);

  const focusPopout = useCallback(() => {
    windowHandleRef.current?.focus();
  }, []);

  return { state, popOutError, popOut, pipSupported, popOutPiP, pipContainer, dockBack, focusPopout };
}
