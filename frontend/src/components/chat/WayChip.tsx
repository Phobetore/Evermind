import { useT } from "@/i18n/useT";
import { nameOfId, wayLabel } from "@/lib/ways";
import type { Outlook } from "@/types";
import { BookOpen, ChevronDown } from "lucide-react";

/** The way the conversation plays, under its input beside the AI's chip: its name, adjusted when it
 *  is, and what it rereads once the AI's reading capacity is full. Never a price. Its words wrap
 *  rather than being cut, at 32px high or more; the row goes to a second line before that.
 *  `current` null: before the first outlook, the name the conversation's `playStyle` gives. */
export function WayChip({ current, playStyle, onOpen }: {
  current: Outlook["current"] | null;
  playStyle: string;
  onOpen(): void;
}) {
  const t = useT();
  let text: string;
  let aria: string;
  if (current) {
    ({ text, aria } = wayLabel(current, t));
  } else {
    // A way a person made is named by the server only: until it says, the chip says what it is.
    text = nameOfId(playStyle, t) ?? t("ways.sheet.title");
    aria = t("ways.chip.aria", { label: text });
  }
  return (
    <button
      type="button"
      data-way-chip
      className="touch-target inline-flex min-h-[32px] min-w-0 max-w-full items-center gap-1.5 rounded-full border border-ink-600 bg-ink-800/60 px-3 py-1 text-left text-xs text-parchment-dim transition-colors hover:border-ink-500 hover:text-parchment"
      onClick={onOpen}
      aria-haspopup="dialog"
      aria-label={aria}
    >
      <BookOpen className="size-[14px] shrink-0 text-ember-300" aria-hidden />
      <span className="min-w-0">{text}</span>
      <ChevronDown className="size-[14px] shrink-0" aria-hidden />
    </button>
  );
}
