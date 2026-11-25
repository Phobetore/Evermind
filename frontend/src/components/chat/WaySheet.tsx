import { Bolded } from "@/components/ai/MigrationNotice";
import { Sheet } from "@/components/ui/Sheet";
import { WayChoices, type WayChange } from "@/components/ways/WayChoices";
import { data, type ConversationPatch } from "@/data";
import { useI18n } from "@/i18n/I18nProvider";
import { UNSENT_ROOM, sizeTold } from "@/lib/ai";
import { describeError } from "@/lib/errors";
import { estimateOf, estimateText, pages, readerOfAi } from "@/lib/estimate";
import { wayName } from "@/lib/ways";
import type { Ai, Conversation, Outlook, WayFields } from "@/types";
import { clsx } from "clsx";
import { Check, ChevronRight, Loader2 } from "lucide-react";
import { useRef, useState } from "react";
import { Link } from "react-router";
import { ReadingBlock } from "./ReadingBlock";

/** As the list of models tells a very large text size: a root of 24px or more. */
const HUGE_ROOT_PX = 24;
/** The room long replies need: an AI keeping a ceiling of its own under it cuts them (conception F). */
const LONG_ROOM = 2048;
/** The fold's own gutters: layout, not text, so in pixels at most; in rem, the largest text would
 *  leave its title's last word no room. */
const FOLD_GUTTER = "px-[min(0.75rem,12px)]";

/** The way the conversation plays, for it alone: what its AI reads of it, a row for each way with
 *  what it would reread and cost, then what may cut its replies short, then its own adjustments.
 *  A row touched is sent at once and the sheet closes only at the answer, as the AI's sheet does;
 *  an adjustment is sent at once too and the sheet stays. `onPicked`: the conversation as the
 *  server saved it, after either. `onLetEvermind`: the ceiling of the AI answering lifted, a
 *  setting of the AI's that the page saves and says. `ais` null: an edition with no AIs of its own,
 *  where nothing is priced and no capacity is said. `outlook` null: nothing read yet, and the sheet
 *  answers the touch with its title while it comes; `outlook.ways` empty: the rows on their way. */
export function WaySheet({ conversation, outlook, ais, onPicked, onClose, onLetEvermind }: {
  conversation: Conversation;
  outlook: Outlook | null;
  ais: Ai[] | null;
  onPicked(conversation: Conversation): void;
  onClose(): void;
  onLetEvermind(ai: Ai): void;
}) {
  const { t, locale } = useI18n();
  const [pending, setPending] = useState<string | null>(null);
  const [adjusting, setAdjusting] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  // The touch made last is the one whose answer counts.
  const asked = useRef(0);
  const [huge] = useState(() => parseFloat(getComputedStyle(document.documentElement).fontSize) >= HUGE_ROOT_PX);

  const waiting = (
    <div className="flex justify-center py-6" aria-busy="true">
      <Loader2 className="size-[20px] animate-spin text-mist" aria-hidden />
    </div>
  );
  // The same sheet as the one with its figures, so that it stays open as they come.
  if (!outlook) {
    return <Sheet title={t("ways.sheet.title")} hint={t("ways.sheet.hint")} onClose={onClose}>{waiting}</Sheet>;
  }
  const current = outlook.current;
  const ai = (data.connections && ais && ais.find((each) => each.id === current.model_id)) || null;
  // A capacity nobody told is not said in pages: the AI's line says it is not given.
  const name = ai && sizeTold(ai) ? ai.name : null;

  async function send(changes: ConversationPatch) {
    const sent = ++asked.current;
    setFailed(null);
    try {
      const saved = await data.conversations.update(conversation.id, changes);
      return sent === asked.current ? saved : null;
    } catch (error) {
      if (sent === asked.current) setFailed(describeError(error, t));
      return null;
    }
  }

  async function pick(id: string) {
    if (id === current.way.id && !current.way.adjusted && pending === null) return onClose();
    setPending(id);
    // Another way starts from it whole: the server clears what was adjusted of the one before.
    const saved = await send({ play_style: id });
    setPending((now) => (now === id ? null : now));
    if (!saved) return;
    onClose();
    onPicked(saved);
  }

  async function adjust(changes: ConversationPatch) {
    setAdjusting(true);
    const saved = await send(changes);
    setAdjusting(false);
    if (saved) onPicked(saved);
  }

  /** The key changed, with those adjusted before: the server drops one equal to the way's own. */
  const adjusted = (change: WayChange) => adjust({ play_overrides: { ...(conversation.play_overrides ?? {}), ...change } });

  const reader = ai && readerOfAi(ai);
  const priced = (way: WayFields) => {
    if (!reader) return null;
    const estimate = estimateOf(reader, way);
    // As an AI's line says it: free, no price or one that varies is said by the line in the AI's sheet.
    return estimate.kind === "amount" ? estimateText(estimate, locale, t) : null;
  };
  const capped = ai && ai.reply_cap.mode === "fixed" && ai.reply_cap.tokens !== null && ai.reply_cap.tokens < LONG_ROOM
    ? ai.reply_cap.tokens
    : null;
  const longRoom = ai && ai.reply_cap.mode === "unsent" && current.reply_room > UNSENT_ROOM;
  const wayShown = wayName(current.way, t);

  return (
    <Sheet title={t("ways.sheet.title")} hint={t("ways.sheet.hint")} alert={failed} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <ReadingBlock entry={current} name={name} outlook={outlook} compact={huge} part={huge ? "top" : "whole"} />

        {outlook.ways.length === 0 ? waiting : (
          <div role="radiogroup" aria-label={t("ways.sheet.title")} className="flex flex-col gap-1.5">
            {outlook.ways.map((entry) => {
              const chosen = entry.way.id === current.way.id;
              // The way played: as the conversation plays it, adjustments in, as the AI's sheet counts it.
              const shown = chosen ? current : entry;
              const estimate = priced(shown.way);
              const counts = { read: shown.messages_included, total: shown.messages_total };
              return (
                <button
                  key={entry.way.id}
                  type="button"
                  role="radio"
                  aria-checked={chosen}
                  aria-busy={pending === entry.way.id}
                  onClick={() => pick(entry.way.id)}
                  className={clsx(
                    "flex w-full items-start gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors",
                    chosen ? "border-ember-500/50 bg-ember-glow" : "border-ink-700 hover:border-ink-500 hover:bg-ink-800/60",
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-baseline justify-between gap-x-3">
                      <span className="min-w-0 font-display text-sm font-medium text-parchment [overflow-wrap:anywhere]">
                        {wayName(entry.way, t)}
                      </span>
                      {estimate && <span data-estimate className="text-xs text-mist">{estimate}</span>}
                    </span>
                    <span className="mt-0.5 block text-xs leading-relaxed text-mist">
                      {name !== null
                        ? t("ways.sheet.row", { ...counts, pages: pages(shown.used_tokens) })
                        : t("ways.sheet.rowNoSize", counts)}
                    </span>
                  </span>
                  <span className="mt-0.5 size-[18px] shrink-0" aria-hidden>
                    {pending === entry.way.id ? (
                      <Loader2 className="size-[18px] animate-spin text-mist" />
                    ) : (
                      chosen && <Check className="size-[18px] text-ember-300" />
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {huge && <ReadingBlock entry={current} name={name} outlook={outlook} compact part="bottom" />}

        {ai && capped !== null && (
          // A setting of the AI's, not of the conversation: hence "in all its conversations".
          <div className="rounded-xl border border-ember-500/40 bg-ember-glow px-3 py-2.5 text-sm leading-relaxed text-parchment-dim">
            <p><Bolded text={t("chat.ai.capped", { name: ai.name, tokens: capped })} bold={ai.name} /></p>
            <button type="button" className="btn btn-ghost mt-2 max-w-full whitespace-normal !py-1.5 text-sm" onClick={() => onLetEvermind(ai)}>
              {t("ai.notice.letEvermind")}
            </button>
          </div>
        )}
        {ai && longRoom && (
          <div className="rounded-xl border border-ember-500/40 bg-ember-glow px-3 py-2.5 text-sm leading-relaxed text-parchment-dim">
            <p><Bolded text={t("ways.longRoom.text", { name: ai.name, tokens: UNSENT_ROOM })} bold={ai.name} /></p>
            <button type="button" className="btn btn-ghost mt-2 max-w-full whitespace-normal !py-1.5 text-sm" onClick={() => onLetEvermind(ai)}>
              {t("ways.longRoom.button")}
            </button>
          </div>
        )}

        <details className="group rounded-xl border border-ink-700">
          {/* The chevron and its gap in pixels too, and at a very large text no spacing between the
              letters: "conversation" and "Unterhaltung" are one word each, too wide at 320px otherwise. */}
          <summary
            className={clsx(
              "ui-label flex min-h-11 cursor-pointer list-none items-center gap-[6px] [&::-webkit-details-marker]:hidden",
              FOLD_GUTTER,
              huge && "tracking-normal",
            )}
          >
            <ChevronRight className="size-[16px] shrink-0 transition-transform group-open:rotate-90" aria-hidden="true" />
            {t("ways.sheet.adjust")}
          </summary>
          <div className={clsx("flex flex-col gap-4 border-t border-ink-700 py-3", FOLD_GUTTER)}>
            <WayChoices fields={current.way} onChange={adjusted} busy={adjusting} />
            {current.way.adjusted && (
              <button
                type="button"
                className="btn btn-ghost max-w-full self-start whitespace-normal !py-1.5 text-sm"
                disabled={adjusting}
                onClick={() => adjust({ play_overrides: null })}
              >
                {t("ways.sheet.backTo", { name: wayShown })}
              </button>
            )}
            <Link to={`/settings/way/${encodeURIComponent(current.way.id)}`} className="text-sm text-ember-300 underline-offset-2 hover:underline">
              {t("ways.sheet.editAll", { name: wayShown })}
            </Link>
          </div>
        </details>
      </div>
    </Sheet>
  );
}
