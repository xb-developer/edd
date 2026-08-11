import { describe, expect, it } from "vitest";
import { transitionPopoutState } from "./popoutState.js";

describe("transitionPopoutState", () => {
  it("pop-out request moves docked to open with no timer effect", () => {
    expect(transitionPopoutState("docked", { type: "POP_OUT_REQUESTED" })).toEqual({ state: "open", effect: "none" });
  });

  it("dock-back request moves open to docked with no timer effect", () => {
    expect(transitionPopoutState("open", { type: "DOCK_BACK_REQUESTED" })).toEqual({ state: "docked", effect: "none" });
  });

  it("a closing signal arms a debounce timer without changing state yet — pagehide fires on both a real close and a reload", () => {
    expect(transitionPopoutState("open", { type: "CLOSING_RECEIVED" })).toEqual({ state: "open", effect: "arm-closing-timer" });
  });

  it("a hello arriving after closing cancels the timer and stays open — this is the reload case", () => {
    const afterClosing = transitionPopoutState("open", { type: "CLOSING_RECEIVED" });
    const afterHello = transitionPopoutState(afterClosing.state, { type: "HELLO_RECEIVED" });

    expect(afterHello).toEqual({ state: "open", effect: "cancel-closing-timer" });
  });

  it("the closing timer firing with no hello in between commits to docked — this is the real close case", () => {
    const afterClosing = transitionPopoutState("open", { type: "CLOSING_RECEIVED" });
    const afterTimeout = transitionPopoutState(afterClosing.state, { type: "CLOSING_TIMEOUT_FIRED" });

    expect(afterTimeout).toEqual({ state: "docked", effect: "none" });
  });

  it("a hello received while already docked (e.g. a fresh pop-out mounting) opens without needing an explicit pop-out request first", () => {
    expect(transitionPopoutState("docked", { type: "HELLO_RECEIVED" })).toEqual({ state: "open", effect: "cancel-closing-timer" });
  });

  it("PIP_OPENED moves docked to pip with no timer effect", () => {
    expect(transitionPopoutState("docked", { type: "PIP_OPENED" })).toEqual({ state: "pip", effect: "none" });
  });

  it("PIP_CLOSED moves pip to docked with no timer effect", () => {
    expect(transitionPopoutState("pip", { type: "PIP_CLOSED" })).toEqual({ state: "docked", effect: "none" });
  });

  it("dock-back request also moves pip to docked", () => {
    expect(transitionPopoutState("pip", { type: "DOCK_BACK_REQUESTED" })).toEqual({ state: "docked", effect: "none" });
  });

  it("a stray hello/closing/closing-timeout from the window.open() path is a no-op while pip is active", () => {
    expect(transitionPopoutState("pip", { type: "HELLO_RECEIVED" })).toEqual({ state: "pip", effect: "none" });
    expect(transitionPopoutState("pip", { type: "CLOSING_RECEIVED" })).toEqual({ state: "pip", effect: "none" });
    expect(transitionPopoutState("pip", { type: "CLOSING_TIMEOUT_FIRED" })).toEqual({ state: "pip", effect: "none" });
  });
});
