import { Sheet } from "@/components/ui/Sheet";
import { data } from "@/data";
import { useI18n } from "@/i18n/I18nProvider";
import { describeError } from "@/lib/errors";
import { dayMonth } from "@/lib/utils";
import { Loader2 } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

/** The days the server reads: a date field keeps within them. */
const FIRST_DAY = "2000-01-01";
const LAST_DAY = "2100-12-31";

type Counted = { calls: number; first: string | null; last: string | null };

/** Clearing the history of Spending: everything, or what came before a day. Nothing is chosen on
 *  opening; a choice asks the server what would go, and says it, before "Clear" can be pressed. */
export function ClearSheet({ onClose, onCleared }: { onClose(): void; onCleared(deleted: number): void }) {
  const { t, locale } = useI18n();
  const spending = data.spending!;
  const ids = useId();
  const [what, setWhat] = useState<"all" | "before" | null>(null);
  const [day, setDay] = useState("");
  const [counted, setCounted] = useState<Counted | null>(null);
  const [clearing, setClearing] = useState(false);
  const [failure, setFailure] = useState<{ error: unknown } | null>(null);

  // The choice made, the server counts what it would take; an older count is dropped.
  const asked = useRef(0);
  // A day the server does not read is no choice: nothing is asked for it.
  const before = what === "before" && /^\d{4}-\d{2}-\d{2}$/.test(day) && day >= FIRST_DAY && day <= LAST_DAY ? day : undefined;
  const chosen = what === "all" || before !== undefined;
  useEffect(() => {
    const mine = ++asked.current;
    if (!chosen) return;
    spending.clear({ before, dryRun: true }).then(
      (answer) => {
        if (mine !== asked.current || !("calls" in answer)) return;
        setCounted(answer);
        setFailure(null);
      },
      (error) => mine === asked.current && setFailure({ error }),
    );
  }, [spending, chosen, before]);
  const shown = chosen ? counted : null;

  async function clear() {
    setClearing(true);
    setFailure(null);
    try {
      const answer = await spending.clear({ before, dryRun: false });
      onCleared("deleted" in answer ? answer.deleted : 0);
    } catch (error) {
      setFailure({ error });
      setClearing(false);
    }
  }

  const said = !chosen ? t("spending.clear.choose")
    : !shown ? ""
      : shown.calls === 0 ? t("spending.clear.none")
        : t("spending.clear.count", {
          count: shown.calls,
          first: dayMonth(shown.first ?? "", locale),
          last: dayMonth(shown.last ?? "", locale),
        });
  const radio = "size-[20px] shrink-0 accent-ember-500";

  return (
    <Sheet title={t("spending.clear.title")} onClose={onClose} alert={failure && describeError(failure.error, t)}>
      <fieldset className="flex flex-col gap-3">
        <legend className="sr-only">{t("spending.clear.title")}</legend>
        <label className="flex min-h-11 items-center gap-3 text-sm">
          <input
            type="radio"
            name={`${ids}-what`}
            className={radio}
            checked={what === "all"}
            onChange={() => {
              setCounted(null);
              setWhat("all");
            }}
          />
          {t("spending.clear.all")}
        </label>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <label className="flex min-h-11 items-center gap-3 text-sm">
            <input
              type="radio"
              name={`${ids}-what`}
              className={radio}
              checked={what === "before"}
              onChange={() => {
                setCounted(null);
                setWhat("before");
              }}
            />
            {t("spending.clear.before")}
          </label>
          <input
            type="date"
            className="field max-w-full"
            aria-label={t("spending.clear.before")}
            min={FIRST_DAY}
            max={LAST_DAY}
            value={day}
            onChange={(e) => {
              setCounted(null);
              setDay(e.target.value);
              setWhat("before");
            }}
          />
        </div>
      </fieldset>
      <p id={`${ids}-said`} aria-live="polite" className="mt-4 min-h-5 text-sm text-parchment-dim">{said}</p>
      <div className="mt-4 flex flex-wrap justify-end gap-3">
        <button type="button" className="btn btn-ghost" onClick={onClose}>{t("common.cancel")}</button>
        <button
          type="button"
          className="btn btn-danger"
          aria-describedby={`${ids}-said`}
          disabled={!shown || shown.calls === 0 || clearing}
          onClick={clear}
        >
          {clearing && <Loader2 className="h-4 w-4 animate-spin" />}
          {t("spending.clear.confirm")}
        </button>
      </div>
    </Sheet>
  );
}
