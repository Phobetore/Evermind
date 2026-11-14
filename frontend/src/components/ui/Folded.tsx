import { useT } from "@/i18n/useT";
import { clsx } from "clsx";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

/** Folded at 24rem when taller, with a button to read the rest: on a phone, what follows stays in reach. */
export function Folded({ children }: { children: React.ReactNode }) {
  const t = useT();
  const clip = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const fade = useRef<HTMLDivElement>(null);
  const [tall, setTall] = useState(false);
  const [open, setOpen] = useState(false);
  // What the keyboard reached under the fold, brought into view once the fold is open.
  const reached = useRef<Element | null>(null);

  // Measured again whenever the content changes height: the images that arrive make it taller.
  useEffect(() => {
    const measured = content.current!;
    const observer = new ResizeObserver(() => {
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      setTall(measured.getBoundingClientRect().height > 24 * rem);
    });
    observer.observe(measured);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (!open || !reached.current) return;
    reached.current.scrollIntoView({ block: "nearest" });
    reached.current = null;
  }, [open]);

  const folded = tall && !open;

  return (
    <div>
      <div className="relative">
        <div
          ref={clip}
          className={clsx(folded && "max-h-[24rem] overflow-hidden")}
          // Only on what the fold clips, and on nothing above it: a control already in sight, or
          // the button below, opens nothing, so a person at the keyboard can leave the text folded.
          onFocus={(event) => {
            // A tap or a click focuses what it touches, already in sight: opening then would move
            // it from under the finger, and the tap would land elsewhere. Only the keyboard's
            // focus, the one that can reach what the fold hides, opens it.
            if (!folded || !event.target.matches(":focus-visible")) return;
            const box = clip.current!;
            const inside = box.getBoundingClientRect();
            // Counted in the content, whatever the browser has scrolled the clipped box by to
            // show the focused element.
            const bottom = event.target.getBoundingClientRect().bottom - inside.top + box.scrollTop;
            if (bottom > box.clientHeight - (fade.current?.offsetHeight ?? 0)) {
              reached.current = event.target;
              box.scrollTop = 0;
              setOpen(true);
            }
          }}
        >
          <div ref={content}>{children}</div>
        </div>
        {folded && (
          <div
            ref={fade}
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-ink-950 to-transparent"
          />
        )}
      </div>
      {tall && (
        <button type="button" className="btn btn-ghost mt-2 min-h-11" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? t("ui.folded.less") : t("ui.folded.more")}
        </button>
      )}
    </div>
  );
}
