import { expect, test } from "vitest";
import { winkOnHost } from "./wink";

/** A link that can be told whether its focus came from the keyboard. */
function host(focusVisible = false) {
  return Object.assign(new EventTarget(), {
    focusVisible,
    matches(selector: string) {
      return selector === ":focus-visible" && this.focusVisible;
    },
  });
}

/** The mark's <g>: its attributes, and the animation events that bubble to it from the spark. */
function mark(busy = false) {
  const attributes = new Map<string, string>(busy ? [["data-busy", "true"]] : []);
  return Object.assign(new EventTarget(), {
    getAttribute: (name: string) => attributes.get(name) ?? null,
    setAttribute: (name: string, value: string) => void attributes.set(name, value),
    removeAttribute: (name: string) => void attributes.delete(name),
  });
}

const animation = (kind: "animationend" | "animationcancel", animationName: string) =>
  Object.assign(new Event(kind, { bubbles: true }), { animationName });

const moving = () => false;

test("the pointer coming over the host starts a wink, and its end clears it", () => {
  const [link, g] = [host(), mark()];
  winkOnHost(link as unknown as Element, g as unknown as Element, moving);
  expect(g.getAttribute("data-wink")).toBeNull();

  link.dispatchEvent(new Event("pointerenter"));
  expect(g.getAttribute("data-wink")).toBe("true");
  // Leaving does not end it: only the wink's own end does.
  link.dispatchEvent(new Event("pointerleave"));
  expect(g.getAttribute("data-wink")).toBe("true");
  g.dispatchEvent(animation("animationend", "mark-blink"));
  expect(g.getAttribute("data-wink")).toBeNull();
});

test("a wink cut short (the mark turned busy, less motion was asked) clears it too", () => {
  const [link, g] = [host(), mark()];
  winkOnHost(link as unknown as Element, g as unknown as Element, moving);
  link.dispatchEvent(new Event("pointerenter"));
  g.dispatchEvent(animation("animationcancel", "mark-blink"));
  expect(g.getAttribute("data-wink")).toBeNull();
});

test("only the wink's own end clears it, not another animation's", () => {
  const [link, g] = [host(), mark()];
  winkOnHost(link as unknown as Element, g as unknown as Element, moving);
  link.dispatchEvent(new Event("pointerenter"));
  g.dispatchEvent(animation("animationend", "rise"));
  expect(g.getAttribute("data-wink")).toBe("true");
});

test("the keyboard's focus starts a wink, a click's focus does not start a second one", () => {
  const keyboard = host(true);
  const g = mark();
  winkOnHost(keyboard as unknown as Element, g as unknown as Element, moving);
  keyboard.dispatchEvent(new Event("focus"));
  expect(g.getAttribute("data-wink")).toBe("true");

  const clicked = host(false);
  const h = mark();
  winkOnHost(clicked as unknown as Element, h as unknown as Element, moving);
  clicked.dispatchEvent(new Event("focus"));
  expect(h.getAttribute("data-wink")).toBeNull();
});

test("a busy mark never winks, and is left nothing that would wink it once the wait is over", () => {
  const [link, g] = [host(true), mark(true)];
  winkOnHost(link as unknown as Element, g as unknown as Element, moving);
  link.dispatchEvent(new Event("pointerenter"));
  link.dispatchEvent(new Event("focus"));
  expect(g.getAttribute("data-wink")).toBeNull();
});

test("asked for less motion, nothing winks and no attribute is left behind", () => {
  const [link, g] = [host(true), mark()];
  winkOnHost(link as unknown as Element, g as unknown as Element, () => true);
  link.dispatchEvent(new Event("pointerenter"));
  link.dispatchEvent(new Event("focus"));
  expect(g.getAttribute("data-wink")).toBeNull();
});

test("once let go, the host no longer winks the mark, and a wink in flight is cleared", () => {
  const [link, g] = [host(), mark()];
  const letGo = winkOnHost(link as unknown as Element, g as unknown as Element, moving);
  link.dispatchEvent(new Event("pointerenter"));
  letGo();
  expect(g.getAttribute("data-wink")).toBeNull();
  link.dispatchEvent(new Event("pointerenter"));
  expect(g.getAttribute("data-wink")).toBeNull();
});
