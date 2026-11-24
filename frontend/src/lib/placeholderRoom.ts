import { useCallback } from "react";

/** A callback ref for a textarea whose placeholder runs over several lines: the box is made as tall as
 *  its placeholder needs at its width (a phone's narrow one cuts the last lines), and never shorter
 *  than its own style makes it. Measured again as its width changes and once the fonts are in. */
export function usePlaceholderRoom(placeholder: string | undefined) {
  return useCallback((node: HTMLTextAreaElement | null) => {
    if (!node || !placeholder) return;
    let width = -1;
    const measure = () => {
      if (!node.isConnected) return;
      const box = node.getBoundingClientRect();
      if (box.width === 0 || box.width === width) return;
      width = box.width;
      node.style.minHeight = "";
      const style = getComputedStyle(node);
      const probe = document.createElement("div");
      for (const key of [
        "fontFamily", "fontSize", "fontWeight", "fontStyle", "letterSpacing", "lineHeight", "wordSpacing",
        "paddingTop", "paddingBottom", "paddingLeft", "paddingRight",
        "borderTopWidth", "borderBottomWidth", "borderLeftWidth", "borderRightWidth", "boxSizing",
      ] as const) probe.style[key] = style[key];
      Object.assign(probe.style, {
        position: "absolute", visibility: "hidden", left: "-9999px", top: "0",
        width: `${box.width}px`, whiteSpace: "pre-wrap", overflowWrap: "break-word", borderStyle: "solid",
      });
      probe.textContent = placeholder;
      document.body.append(probe);
      const needed = probe.getBoundingClientRect().height;
      probe.remove();
      if (needed > node.getBoundingClientRect().height + 0.5) node.style.minHeight = `${Math.ceil(needed)}px`;
    };
    const watch = new ResizeObserver(measure);
    watch.observe(node);
    void document.fonts?.ready.then(() => {
      width = -1;
      measure();
    });
    return () => {
      watch.disconnect();
      node.style.minHeight = "";
    };
  }, [placeholder]);
}
