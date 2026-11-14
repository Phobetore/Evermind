type Host = Pick<Element, "addEventListener" | "removeEventListener" | "matches">;
type MarkGroup = Pick<Element, "addEventListener" | "removeEventListener" | "getAttribute" | "setAttribute" | "removeAttribute">;

/**
 * Lets a wink run to its end. The wink is CSS (styles.css, "The mark"), played while the host is
 * hovered or has the keyboard's focus; a pointer that leaves half-way would take it away and snap the
 * spark open. So when the pointer comes over the host, or the keyboard's focus arrives on it, the
 * mark's <g> is also marked `data-wink="true"`, which plays the same animation, and the mark loses it
 * when that wink ends or is cut short (the mark turned busy, less motion was asked).
 *
 * A busy mark is not marked: it does not wink, and a mark left behind would wink it once the wait is
 * over. Nor is anything marked when `still()` says less motion was asked. Returns what lets go.
 */
export function winkOnHost(host: Host, mark: MarkGroup, still: () => boolean): () => void {
  const start = () => {
    if (mark.getAttribute("data-busy") === "true" || still()) return;
    mark.setAttribute("data-wink", "true");
  };
  // A click focuses the link too, as the pointer is already there: only the keyboard's focus winks,
  // as only :focus-visible does in the stylesheet.
  const focus = () => {
    if (host.matches(":focus-visible")) start();
  };
  const end = (event: Event) => {
    if ((event as AnimationEvent).animationName === "mark-blink") mark.removeAttribute("data-wink");
  };
  host.addEventListener("pointerenter", start);
  host.addEventListener("focus", focus);
  mark.addEventListener("animationend", end);
  mark.addEventListener("animationcancel", end);
  return () => {
    host.removeEventListener("pointerenter", start);
    host.removeEventListener("focus", focus);
    mark.removeEventListener("animationend", end);
    mark.removeEventListener("animationcancel", end);
    mark.removeAttribute("data-wink");
  };
}
