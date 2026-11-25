import { HATCHED, PART_CLASS } from "@/components/ways/ReadingCard";
import { useT } from "@/i18n/useT";
import { isFull, lighterSaying, pagesPart, readingLine } from "@/lib/ways";
import type { Outlook } from "@/types";
import { ChevronDown } from "lucide-react";

const PARTS = ["card", "reminders", "history", "room"] as const;

/** What the conversation's AI reads of it under its way: the pages sent and the messages reread,
 *  then, when its capacity is full, that it is; the bar of the parts, their names, and why, folded.
 *  `name` null: no AI, or no capacity said, and then only what the way rereads, with no bar and no
 *  pages. `part`: at a very large text size (`compact`) the first line stays above the list of the
 *  ways and the rest goes under it, so that the ways are still in reach. */
export function ReadingBlock({ entry, name, outlook, compact, part }: {
  entry: Outlook["current"];
  name: string | null;
  outlook: Outlook;
  compact: boolean;
  part: "top" | "bottom" | "whole";
}) {
  const t = useT();
  const line = part !== "bottom";
  const rest = name !== null && (part === "bottom" || (part === "whole" && !compact));
  if (!line && !rest) return null;
  const full = isFull(entry);
  const tokens = {
    card: entry.parts.card,
    reminders: entry.parts.reminders,
    history: entry.parts.history,
    // What the turn keeps, as the card in Settings draws it; the way's room from a server that
    // does not say it.
    room: entry.reply_kept ?? entry.reply_room,
  };
  const width = (count: number) => `${Math.min(100, (count / entry.context_size) * 100).toFixed(2)}%`;
  const lighter = full ? lighterSaying(outlook, t) : null;
  return (
    <div className="flex flex-col gap-2">
      {line && <p className="text-sm leading-relaxed text-parchment">{readingLine(entry, name, t)}</p>}
      {rest && (
        <>
          {full && (
            <p className="text-sm leading-relaxed text-parchment-dim">
              {t("ways.reading.full", { capacity: pagesPart(entry.context_size, t), sent: pagesPart(entry.used_tokens, t, true) })}
            </p>
          )}
          {/* The words are in the key under it and in the fold: the bar only draws them. */}
          <div data-reading-bar aria-hidden="true" className="flex h-3 overflow-hidden rounded-full bg-ink-700">
            {PARTS.map((key) => (
              <i key={key} className={`block h-full ${PART_CLASS[key]}`} style={{ width: width(tokens[key]), ...(key === "room" ? HATCHED : {}) }} />
            ))}
          </div>
          <details className="group">
            {/* The key of the bar, then Why: one line that opens on what the figures are. The key's
                names are drawn only; the fold says them with their figures. */}
            <summary className="flex min-h-11 cursor-pointer list-none flex-wrap items-center gap-x-4 gap-y-1 text-xs text-mist [&::-webkit-details-marker]:hidden">
              {PARTS.map((key) => (
                <span key={key} aria-hidden="true" className="flex items-center gap-1.5">
                  <span className={`h-2.5 w-2.5 shrink-0 rounded-sm ${PART_CLASS[key]}`} style={key === "room" ? HATCHED : undefined} />
                  {t(`ways.bar.${key}`)}
                </span>
              ))}
              <span className="flex items-center gap-1 text-parchment-dim">
                {t("ways.reading.why")}
                <ChevronDown className="size-[14px] shrink-0 transition-transform group-open:rotate-180" aria-hidden="true" />
              </span>
            </summary>
            <div className="mt-1 flex flex-col gap-2 text-sm leading-relaxed text-parchment-dim">
              {full && <p>{t("ways.reading.limit")}</p>}
              {lighter && <p className="text-ember-300">{lighter}</p>}
              <p className="text-xs text-mist">
                {t("ways.reading.legend", { ...tokens, capacity: entry.context_size })}
              </p>
            </div>
          </details>
        </>
      )}
    </div>
  );
}
