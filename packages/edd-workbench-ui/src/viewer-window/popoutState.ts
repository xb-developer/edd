export type PopoutState = "docked" | "open" | "pip";

export type PopoutAction =
  | { type: "POP_OUT_REQUESTED" }
  | { type: "HELLO_RECEIVED" }
  | { type: "CLOSING_RECEIVED" }
  | { type: "CLOSING_TIMEOUT_FIRED" }
  | { type: "DOCK_BACK_REQUESTED" }
  | { type: "PIP_OPENED" }
  | { type: "PIP_CLOSED" };

export type PopoutEffect = "none" | "arm-closing-timer" | "cancel-closing-timer";

export interface PopoutTransitionResult {
  state: PopoutState;
  effect: PopoutEffect;
}

/**
 * Pure docked/popped-out/pip transition table — no DOM, no timers, no
 * BroadcastChannel/sessionStorage/documentPictureInPicture access here. The
 * effectful shell (`useViewerWindow.ts`) owns the real timers/channel/PiP
 * window and interprets `"arm-closing-timer"`/`"cancel-closing-timer"` as an
 * actual `setTimeout` schedule/clear; this function only decides which
 * effect a transition calls for.
 *
 * The `closing`/`hello` dance (for `"open"`, the `window.open()` path) exists
 * because a browser `pagehide` event fires on both a genuine window close
 * and a page reload — there's no way to tell them apart from that event
 * alone. `CLOSING_RECEIVED` arms a timer rather than committing to `docked`
 * immediately; if the popped-out window was actually just reloading, its
 * `hello` (sent again on mount) arrives before the timer fires and cancels
 * it via `HELLO_RECEIVED`.
 *
 * PiP (`"pip"`) is a genuinely different mechanism — a `documentPictureInPicture`
 * window shares the *same* JS realm/React tree as the opener (a
 * `createPortal` target, not a separately-loaded page), so it never sends
 * or expects a `hello`/`closing` message at all. A stray signal from an
 * unrelated `window.open()` fallback window must not be able to knock a
 * live `pip` session back to `docked` — every `hello`/`closing`-family
 * action below is a no-op while `current === "pip"`.
 */
export function transitionPopoutState(current: PopoutState, action: PopoutAction): PopoutTransitionResult {
  switch (action.type) {
    case "POP_OUT_REQUESTED":
      return { state: "open", effect: "none" };
    case "HELLO_RECEIVED":
      return current === "pip" ? { state: current, effect: "none" } : { state: "open", effect: "cancel-closing-timer" };
    case "CLOSING_RECEIVED":
      return current === "pip" ? { state: current, effect: "none" } : { state: current, effect: "arm-closing-timer" };
    case "CLOSING_TIMEOUT_FIRED":
      return current === "pip" ? { state: current, effect: "none" } : { state: "docked", effect: "none" };
    case "DOCK_BACK_REQUESTED":
      return { state: "docked", effect: "none" };
    case "PIP_OPENED":
      return { state: "pip", effect: "none" };
    case "PIP_CLOSED":
      return { state: "docked", effect: "none" };
  }
}
