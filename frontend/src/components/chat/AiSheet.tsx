import { AiLine } from "@/components/ai/AiLine";
import { EstimateLine } from "@/components/ai/EstimateLine";
import { Bolded } from "@/components/ai/MigrationNotice";
import { Sheet, SheetWait } from "@/components/ui/Sheet";
import { data, DataError, type AiSaved } from "@/data";
import { useT } from "@/i18n/useT";
import { answering, cappedUnder, sizeTold, splitName } from "@/lib/ai";
import { describeError } from "@/lib/errors";
import { estimateOf, readerOfAi } from "@/lib/estimate";
import { sheetRow } from "@/lib/ways";
import type { Ai, Conversation, Outlook } from "@/types";
import { clsx } from "clsx";
import { Bot, Check, ChevronDown, Loader2, Plus, RefreshCw } from "lucide-react";
import { useRef, useState } from "react";
import { Link } from "react-router";

/** What answers the conversation, under its input: the AI's name cut in the middle, which opens the
 *  sheet that changes it; with no AI at all, the way to add one. */
export function AiChip({ ai, onOpen }: { ai: Ai | null; onOpen(): void }) {
  const t = useT();
  // 32px to look at, 44px to touch (touch-target); in px, as the input's buttons, whatever the text's size.
  const shape =
    "touch-target inline-flex h-[32px] min-w-0 max-w-max flex-[1_1_11em] items-center gap-1.5 rounded-full border border-ink-600 bg-ink-800/60 px-3 text-xs text-parchment-dim transition-colors hover:border-ink-500 hover:text-parchment";
  if (!ai) {
    return (
      <button type="button" data-ai-chip className={shape} onClick={onOpen} aria-haspopup="dialog">
        <Plus className="size-[14px] shrink-0 text-ember-300" />
        <span className="truncate">{t("chat.ai.addOne")}</span>
      </button>
    );
  }
  const [head, tail] = splitName(ai.name);
  return (
    <button
      type="button"
      data-ai-chip
      className={shape}
      onClick={onOpen}
      aria-haspopup="dialog"
      aria-label={t("chat.ai.chip", { name: ai.name })}
      title={ai.name}
    >
      <Bot className="size-[14px] shrink-0 text-ember-300" />
      {/* Cut in the middle: two models of one family differ at the end of their names. */}
      <span className="flex min-w-0 flex-1">
        <span className="truncate">{head}</span>
        {tail && <span className="shrink-0 whitespace-pre">{tail}</span>}
      </span>
      <ChevronDown className="size-[14px] shrink-0" />
    </button>
  );
}

/** Where the chip would be when the AIs could not be read: says so, and reads them again when touched.
 *  Its sentence wraps rather than being cut, at 32px high or more. */
export function AiUnread({ onRetry }: { onRetry(): void }) {
  const t = useT();
  return (
    <button
      type="button"
      data-ai-unread
      className="touch-target inline-flex min-h-[32px] min-w-0 max-w-full items-center gap-1.5 rounded-full border border-ink-600 bg-ink-800/60 px-3 py-1 text-left text-xs text-parchment-dim transition-colors hover:border-ink-500 hover:text-parchment"
      onClick={onRetry}
    >
      <RefreshCw className="size-[14px] shrink-0 text-ember-300" />
      <span className="min-w-0 [overflow-wrap:anywhere]">{t("chat.ai.unread")}</span>
    </button>
  );
}

/** Which AI answers the conversation: a row for each, with what it reads and costs, since this is
 *  where one is changed. A row touched is sent at once and the sheet closes only at the answer, so
 *  that nobody believes the AI changed when it did not. `onCapLifted`: the AI answering now no longer
 *  keeps a ceiling of its own, a setting of the AI's, saved from here; the page closes the sheet to say so.
 *  `onGone`: the AI picked no longer exists on the server (removed on another device). `outlook`:
 *  what each AI would read under the conversation's way, read as the sheet opens; null until it
 *  comes, and until then the sheet warns of no ceiling and gives no row its figures. `waiting`:
 *  the outlook was asked and has neither come nor failed; the rows are not drawn meanwhile, so that
 *  they do not move under a touch as their figures come, and are drawn once it has come or failed,
 *  without figures then. Not given, the rows are drawn at once. */
export function AiSheet({ conversation, ais, outlook, waiting = false, onPick, onGone, onAddOther, onClose, onCapLifted }: {
  conversation: Conversation;
  ais: Ai[];
  outlook: Outlook | null;
  waiting?: boolean;
  onPick(ai: Ai): void;
  onGone(ai: Ai): void;
  onAddOther(): void;
  onClose(): void;
  onCapLifted(ai: AiSaved): void;
}) {
  const t = useT();
  const current = answering(conversation.model_id, ais);
  const [pending, setPending] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [lifting, setLifting] = useState(false);
  // The row touched last is the one whose answer counts: the others stay touchable meanwhile.
  const asked = useRef(0);

  async function pick(ai: Ai) {
    if (ai.id === current?.id && pending === null) return onClose();
    const sent = ++asked.current;
    setPending(ai.id);
    setFailed(null);
    try {
      await data.conversations.update(conversation.id, { model_id: ai.id });
      if (sent === asked.current) onPick(ai);
    } catch (error) {
      if (sent !== asked.current) return;
      setPending(null);
      setFailed(describeError(error, t));
      if (error instanceof DataError && error.kind === "not_found" && error.resource === "model") onGone(ai);
    }
  }

  async function lift(ai: Ai) {
    if (!data.connections || lifting) return;
    setLifting(true);
    setFailed(null);
    try {
      onCapLifted(await data.connections.models.update(ai.id, { reply_cap: { mode: "auto" } }));
    } catch (error) {
      setFailed(describeError(error, t));
    } finally {
      setLifting(false);
    }
  }

  // The room the conversation's way keeps for a reply, adjustments in.
  const room = outlook?.current.reply_room ?? 0;
  const capped = current && cappedUnder(current, room);
  // The rows' estimates are of a long story, as everywhere an AI or a way is chosen: said once.
  const priced = outlook !== null && ais.some((ai) => estimateOf(readerOfAi(ai), outlook.current.way).kind === "amount");
  return (
    <Sheet title={t("chat.ai.sheetTitle")} hint={t("chat.ai.sheetHint")} alert={failed} onClose={onClose}>
      {current && capped !== null && (
        // A setting of the AI's, not of the conversation: hence "in all its conversations".
        <div className="mb-3 rounded-xl border border-ember-500/40 bg-ember-glow px-3 py-2.5 text-sm leading-relaxed text-parchment-dim">
          <p>
            <Bolded text={t("chat.ai.capped", { name: current.name, tokens: capped })} bold={current.name} />
          </p>
          <button type="button" className="btn btn-ghost mt-2 max-w-full whitespace-normal !py-1.5 text-sm" disabled={lifting} onClick={() => lift(current)}>
            {lifting && <Loader2 className="h-4 w-4 animate-spin" />}
            {t("ai.notice.letEvermind")}
          </button>
        </div>
      )}
      {waiting ? <SheetWait /> : (
        <div role="radiogroup" aria-label={t("chat.ai.sheetTitle")} className="flex flex-col gap-1.5">
          {ais.map((ai) => {
            const chosen = ai.id === current?.id;
            const busy = ai.id === pending;
            const cut = chosen ? null : cappedUnder(ai, room);
            const reading = outlook?.models.find((entry) => entry.model_id === ai.id);
            return (
              <button
                key={ai.id}
                type="button"
                role="radio"
                aria-checked={chosen}
                aria-busy={busy}
                onClick={() => pick(ai)}
                className={clsx(
                  "flex w-full items-start gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors",
                  chosen ? "border-ember-500/50 bg-ember-glow" : "border-ink-700 hover:border-ink-500 hover:bg-ink-800/60",
                )}
              >
                <div className="min-w-0 flex-1">
                  <AiLine
                    ai={ai}
                    extra={(
                      <>
                        {reading && (
                          <span className="mt-0.5 block text-xs leading-relaxed text-mist">
                            {/* No pages for a capacity nobody told, as its line above says. */}
                            {sheetRow(reading.messages_included, reading.messages_total, sizeTold(ai) ? reading.used_tokens : null, t)}
                          </span>
                        )}
                        {/* Under the conversation's way as it plays it, as its row in the sheet of the ways. */}
                        {outlook && <EstimateLine reader={readerOfAi(ai)} way={outlook.current.way} />}
                        {cut !== null && (
                          <span className="mt-1 block text-xs text-ember-300">{t("chat.ai.cappedOther", { tokens: cut })}</span>
                        )}
                      </>
                    )}
                  />
                </div>
                <span className="mt-0.5 size-[18px] shrink-0" aria-hidden>
                  {busy ? (
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
      {priced && !waiting && <p className="mt-2 text-xs text-mist">{t("ways.card.reference")}</p>}
      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" className="btn btn-ghost flex-1 whitespace-normal" onClick={onAddOther}>
          {t("chat.ai.otherModel")}
        </button>
        <Link to="/settings" className="btn btn-ghost flex-1 whitespace-normal">
          {t("chat.ai.manage")}
        </Link>
      </div>
    </Sheet>
  );
}
