import type { AssistField, AssistState } from "@/data";
import { useT } from "@/i18n/useT";
import { formatClock, progress } from "@/lib/assist";
import { clsx } from "clsx";
import { Check, Loader2, Square } from "lucide-react";
import { useEffect, useState } from "react";

/** The card being written: how long it has taken, what the model is doing, which fields are in, and
 *  the way to stop it. `state` is the last the server gave, `since` the moment it came (or the job began,
 *  if none has yet): the clock counts in the page between two states. */
export function AssistProgress({
  state, since, waiting, stopping, label, onStop,
}: {
  state: AssistState | null;
  since: number;
  waiting: boolean;
  stopping: boolean;
  label: (field: AssistField) => string;
  onStop: () => void;
}) {
  const t = useT();
  const [now, setNow] = useState(since);
  useEffect(() => {
    // The clock is its own: a tick must not draw the whole form again.
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);
  // Before the first state, nothing has been written yet.
  const shown = progress(state ?? { fields: [], lore: 0, written: 0, thought: 0, writing: null });
  const seconds = (state?.seconds ?? 0) + Math.max(0, now - since) / 1000;
  const { situation } = shown;

  return (
    <div className="mt-3 rounded-lg border border-ember-600/25 bg-ink-900/50 p-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {/* Announced as it changes, politely; the clock is not, or it would be read out every second. */}
        <div aria-live="polite" className="min-w-0 flex-1 basis-44 text-sm text-parchment">
          <p className="flex items-start gap-2 break-words">
            <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-ember-400" aria-hidden="true" />
            <span className="min-w-0">
              {situation.kind === "waiting" && t("characters.assist.statusWaiting")}
              {situation.kind === "thinking" && t("characters.assist.statusThinking", { chars: situation.thought })}
              {situation.kind === "writing" && t("characters.assist.statusWriting", { field: label(situation.field) })}
              {situation.kind === "between" && t("characters.assist.statusBetween")}
            </span>
          </p>
          {waiting && <p className="mt-1 break-words text-xs text-ember-300">{t("characters.assist.connectionWait")}</p>}
        </div>
        <span role="timer" aria-label={t("characters.assist.elapsedLabel")} className="font-mono text-sm tabular-nums text-mist">
          {formatClock(seconds)}
        </span>
        <button
          type="button"
          className="btn btn-ghost !px-2.5 !py-1 text-xs"
          onClick={onStop}
          disabled={stopping}
        >
          <Square className="h-3.5 w-3.5" aria-hidden="true" />{" "}
          {stopping ? t("characters.assist.stoppingButton") : t("characters.assist.stopButton")}
        </button>
      </div>
      <ul aria-label={t("characters.assist.progressLabel")} className="mt-3 flex flex-wrap gap-1.5">
        {shown.fields.map(({ field, done }) => {
          const writing = situation.kind === "writing" && situation.field === field;
          const count = field === "lore_entries" && shown.lore > 0 ? ` ${shown.lore}` : "";
          return (
            <li
              key={field}
              className={clsx(
                "flex max-w-full items-center gap-1 break-words rounded-full border px-2 py-0.5 text-[0.7rem]",
                done
                  ? "border-ember-500/50 bg-ember-glow text-ember-300"
                  : writing
                    ? "border-ember-500/40 text-parchment"
                    : count
                      ? "border-ink-600 text-mist"
                      : "border-ink-700 text-mist-dim",
              )}
            >
              {done && <Check className="h-3 w-3 shrink-0" aria-hidden="true" />}
              <span className="min-w-0">{label(field)}{count}</span>
              {done && <span className="sr-only">{t("characters.assist.chipDone")}</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
