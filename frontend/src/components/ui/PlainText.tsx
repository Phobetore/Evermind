import { useT } from "@/i18n/useT";
import { plainCuts, plainPart } from "@/lib/presentation/bounds";
import { clsx } from "clsx";
import { useEffect, useMemo, useRef, useState } from "react";

/** A text shown as written, line breaks kept (whitespace-pre-wrap break-words overflow-clip, plus
 *  className: combining marks stacked on one letter paint nothing outside its box);
 *  past PLAIN_PART characters, or a cost of the browser's own layout, one part at a time
 *  (plainCuts and plainPart of @/lib/presentation/bounds), with
 *  « Part i of n » and two buttons to move between parts. One text node of tens of megabytes would
 *  hold a phone's only thread on every visit, folded or not. */
export function PlainText({ text, className }: { text: string; className?: string }) {
  const t = useT();
  // The part belongs to the text it was chosen in: another text starts at its first part.
  const [chosen, setChosen] = useState({ text, index: 0 });
  const index = chosen.text === text ? chosen.index : 0;
  // Where the parts start, found once per text: one walk over it, however many parts are read.
  const cuts = useMemo(() => plainCuts(text), [text]);
  const { part, count } = useMemo(() => plainPart(text, index, cuts), [text, index, cuts]);
  const shown = useRef<HTMLParagraphElement>(null);
  const moved = useRef(false);

  // Once the new part is drawn, its start is brought back on screen, by its top: "nearest" would
  // line up the bottom of a part taller than the screen, and the reading would start at its end.
  useEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    const box = shown.current;
    if (!box) return;
    const top = box.getBoundingClientRect().top;
    if (top < 0 || top > window.innerHeight) box.scrollIntoView({ block: "start" });
  }, [index]);

  const move = (to: number) => {
    moved.current = true;
    setChosen({ text, index: to });
  };

  return (
    <>
      <p ref={shown} className={clsx("whitespace-pre-wrap break-words overflow-clip", className)}>
        {part}
      </p>
      {count > 1 && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button type="button" className="btn btn-ghost min-h-11" disabled={index === 0} onClick={() => move(index - 1)}>
            {t("ui.plainText.previous")}
          </button>
          <span className="text-sm text-mist">{t("ui.plainText.part", { index: index + 1, count })}</span>
          <button
            type="button"
            className="btn btn-ghost min-h-11"
            disabled={index === count - 1}
            onClick={() => move(index + 1)}
          >
            {t("ui.plainText.next")}
          </button>
        </div>
      )}
    </>
  );
}
