import { firstCodePoints } from "@/lib/utils";
import { clsx } from "clsx";

/** A tag's own text, on one line at most, cut with an ellipsis, its first 2 000 code points in
 *  `title` as in the text. A block: an inline box in Tag's flex row would be clipped without the
 *  ellipsis. Only what is drawn is cut: the tag's value (a filter, a removal) stays the whole tag.
 *  Truncation hides what overflows but the browser still lays it out, and a card's tag has no
 *  bound of length. For every chip that shows a tag of a card; the chip takes max-w-full. */
export function TagText({ tag }: { tag: string }) {
  const shown = firstCodePoints(tag, 2_000);
  return (
    <span className="block min-w-0 truncate" title={shown}>
      {shown}
    </span>
  );
}

export function Tag({
  children,
  tone = "neutral",
  className,
}: {
  children: React.ReactNode;
  tone?: "neutral" | "ember" | "arcane";
  className?: string;
}) {
  return (
    <span
      className={clsx(
        "inline-flex items-center rounded-full border px-2.5 py-0.5 font-display text-[0.7rem] font-medium tracking-wide",
        tone === "ember" && "border-ember-600/40 bg-ember-glow text-ember-300",
        tone === "arcane" && "border-arcane-500/40 bg-arcane-glow text-arcane-300",
        tone === "neutral" && "border-ink-600 bg-ink-800 text-mist",
        className,
      )}
    >
      {children}
    </span>
  );
}
