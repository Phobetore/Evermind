import { Bars } from "@/components/spending/Bars";
import { ClearSheet } from "@/components/spending/ClearSheet";
import { CutList, type Opened } from "@/components/spending/CutList";
import { LineDetail } from "@/components/spending/LineDetail";
import { choiceClass, Periods } from "@/components/spending/Periods";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { data, type Cut, type SpendingQuery } from "@/data";
import { useI18n } from "@/i18n/I18nProvider";
import { describeError } from "@/lib/errors";
import {
  amountText, daysOf, keepPeriod, keptPeriod, localDate, moneyText, rangeOf, spendingShown, type Period,
} from "@/lib/spending";
import { dayMonth, downloadBlob } from "@/lib/utils";
import type { Spending } from "@/types";
import { clsx } from "clsx";
import { ArrowLeft, ChevronRight } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Navigate, useLocation, useNavigate, useSearchParams } from "react-router";

/** The page's side gutters: layout, not text, so in pixels at most (as on an AI's page). */
const GUTTER = "px-[min(1.5rem,24px)]";
/** From here the detail of a line stands beside the list rather than over it. */
const WIDE = "(min-width: 64rem)";
/** Long enough to read a line, as the conversation's own toasts. */
const TOAST_MS = 4200;
const PERIODS: readonly string[] = ["7", "30", "month", "last", "all"] satisfies Period[];
const CUTS: Cut[] = ["model", "card", "conversation", "use"];

/** The route /spending: what the AIs cost, by period and four cuts, as sums. Opening it asks the
 *  server once; a period or a filter, once; a line opened, once. `?per=` is the period of this
 *  visit only; `?cut=&key=` open that line. */
export function SpendingPage() {
  // An edition with nothing counted has no page of it.
  if (!spendingShown(data)) return <Navigate to="/settings" replace />;
  return <SpendingView />;
}

function useWide(): boolean {
  const [wide, setWide] = useState(() => window.matchMedia(WIDE).matches);
  useEffect(() => {
    const query = window.matchMedia(WIDE);
    const changed = () => setWide(query.matches);
    query.addEventListener("change", changed);
    return () => query.removeEventListener("change", changed);
  }, []);
  return wide;
}

function SpendingView() {
  const { t, locale } = useI18n();
  const spending = data.spending!;
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const wide = useWide();
  const filterId = useId();

  // What the address asks, read once: the period of this visit does not become the one kept.
  const [asked] = useState(() => {
    const per = params.get("per");
    const cut = params.get("cut") as Cut | null;
    const key = params.get("key");
    return {
      per: per !== null && PERIODS.includes(per) ? (per as Period) : keptPeriod(),
      opened: cut !== null && CUTS.includes(cut) && key !== null ? { cut, key, name: "" } : null,
    };
  });
  const [per, setPer] = useState<Period>(asked.per);
  const [cut, setCut] = useState<Cut>(asked.opened?.cut ?? "model");
  const [model, setModel] = useState("");
  const [summary, setSummary] = useState<Spending | null>(null);
  const [failure, setFailure] = useState<{ error: unknown } | null>(null);
  const [opened, setOpened] = useState<Opened | null>(asked.opened);
  const [clearing, setClearing] = useState(false);
  const [toast, setToast] = useState<{ text: string; at: number } | null>(null);
  // Each read of everything again: a line opened reads itself again with it.
  const [reads, setReads] = useState(0);
  // The day the page was opened, or read again: the periods end on it.
  const [today, setToday] = useState(() => new Date());
  const range = rangeOf(per, today);
  const { from, to } = range;

  const answered = useRef(0);
  const read = useCallback(() => {
    const mine = ++answered.current;
    const query: SpendingQuery = { from, to, model: model || undefined };
    spending.summary(query).then(
      (found) => {
        if (mine !== answered.current) return;
        setSummary(found);
        setFailure(null);
      },
      (error) => mine === answered.current && setFailure({ error }),
    );
  }, [spending, from, to, model]);
  useEffect(() => {
    read();
  }, [read, reads]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);
  const say = (text: string) => setToast({ text, at: performance.now() });

  /** Everything read again, today included: after a clear or a price that filled earlier calls. */
  function readAgain() {
    setReads((n) => n + 1);
    setToday(new Date());
  }

  function choosePeriod(next: Period) {
    keepPeriod(next);
    setPer(next);
  }

  function back() {
    if (location.key !== "default") navigate(-1);
    else navigate("/settings");
  }

  function closeLine() {
    const key = opened?.key;
    setOpened(null);
    // The line it was, in sight in the list.
    requestAnimationFrame(() => {
      const row = key === undefined ? null : document.querySelector(`[data-cut-list] [data-key="${CSS.escape(key)}"]`);
      row?.scrollIntoView({ block: "center" });
    });
  }

  function forgot(which: "card" | "conversation", key: string) {
    setSummary((before) => before && (which === "conversation"
      ? { ...before, conversations: before.conversations.map((c) => (c[0] === key ? [c[0], null, ...c.slice(2)] as typeof c : c)) }
      : { ...before, cards: before.cards.map((c) => (c[0] === key ? [c[0], null, ...c.slice(2)] as typeof c : c)) }));
    // Her conversations' titles went with her name: they are read again.
    if (which === "card") read();
  }

  async function exportFile() {
    try {
      const { blob, filename } = await spending.exportCsv({ from, to });
      downloadBlob(blob, filename);
      say(t("spending.exported", { name: filename }));
    } catch (error) {
      say(describeError(error, t));
    }
  }

  function cleared(deleted: number) {
    setClearing(false);
    say(t("spending.cleared", { count: deleted }));
    // The page scrolls inside <main>.
    document.querySelector("main")?.scrollTo(0, 0);
    window.scrollTo(0, 0);
    readAgain();
  }

  const money = (cost: number, unpriced = 0) =>
    moneyText({ cost, unpriced, currency: summary?.currency ?? "USD" }, "total", locale, t);
  const since = summary ? localDate(new Date(summary.since)) : "";
  const choices = summary ? [
    ...summary.models.map(([id, name]) => [id, name] as const),
    ...summary.free.map(([id, name]) => [id, name] as const),
  ].filter((choice): choice is readonly [string, string | null] => choice[0] !== null) : [];
  const filtered = choices.find(([id]) => id === model);

  let body: React.ReactNode;
  if (failure && !summary) body = <LoadFailure error={failure.error} onRetry={read} />;
  else if (!summary) body = <p className="text-mist animate-pulse-soft">{t("common.loading")}</p>;
  else {
    const empty = summary.calls === 0;
    body = (
      <>
        <section className="flex flex-col gap-1.5">
          <p data-total className="font-display text-4xl font-semibold text-parchment [overflow-wrap:anywhere]">
            {money(summary.total, summary.unpriced.calls)}
          </p>
          {!empty && summary.outside_replies.calls > 0 && (
            <button type="button" className="self-start text-left text-sm text-mist underline-offset-2 hover:text-parchment hover:underline" onClick={() => setCut("use")}>
              {t("spending.outside", { money: amountText(summary.outside_replies.cost, summary.currency, locale, t) })}
            </button>
          )}
          {!empty && summary.previous !== null && from !== undefined && (
            <p className="text-sm text-mist">
              {t("spending.previous", { count: daysOf({ from, to }), money: amountText(summary.previous, summary.currency, locale, t) })}
            </p>
          )}
          {(from === undefined || from < since) && (
            <p className="text-sm text-mist">{t("spending.since", { date: dayMonth(summary.since, locale) })}</p>
          )}
          {empty && <p className="text-sm text-parchment-dim">{t("spending.nothing")}</p>}
        </section>

        {!empty && (
          <>
            <Bars key={`${per}:${from}:${to}:${reads}`} series={summary.series} currency={summary.currency} />

            <section className="flex flex-col gap-3">
              <div role="group" aria-label={t("spending.cut.label")} className="flex flex-wrap gap-2">
                {CUTS.map((each) => (
                  <button key={each} type="button" aria-pressed={each === cut} className={choiceClass(each === cut)} onClick={() => setCut(each)}>
                    {t(`spending.cut.${each}`)}
                  </button>
                ))}
              </div>
              {cut !== "model" && (
                <div className="flex flex-col gap-1.5">
                  <select
                    id={filterId}
                    aria-label={t("spending.cut.model")}
                    className="field w-full max-w-full"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                  >
                    <option value="">{t("spending.filter.all")}</option>
                    {choices.map(([id, name]) => <option key={id} value={id}>{name ?? id}</option>)}
                  </select>
                  {model && filtered && summary.model_total !== null && (
                    <p className="text-sm text-parchment-dim [overflow-wrap:anywhere]">
                      {t("spending.filter.with", {
                        name: filtered[1] ?? model,
                        money: money(summary.model_total, summary.models.find(([id]) => id === model)?.[10] ?? 0),
                      })}
                    </p>
                  )}
                </div>
              )}
            </section>

            <div className={clsx(wide && opened && "grid grid-cols-[minmax(0,1fr)_minmax(0,24rem)] items-start gap-6")}>
              <CutList summary={summary} cut={cut} onOpen={setOpened} />
              {opened && wide && (
                <LineDetail
                  key={`${opened.cut}:${opened.key}`}
                  line={opened}
                  range={range}
                  per={per}
                  since={summary.since}
                  currency={summary.currency}
                  beside
                  reread={reads}
                  onClose={closeLine}
                  onRepriced={readAgain}
                  onForgot={forgot}
                />
              )}
            </div>
          </>
        )}
      </>
    );
  }

  return (
    <div className={clsx("mx-auto flex max-w-3xl flex-col gap-6 py-10 lg:max-w-6xl", GUTTER)}>
      <div>
        <button type="button" onClick={back} className="touch-target mb-4 inline-flex items-center gap-1.5 text-sm text-mist hover:text-parchment">
          <ArrowLeft className="h-4 w-4" aria-hidden />
          {t("ai.add.back")}
        </button>
        <h1 className="font-display text-3xl font-semibold">{t("spending.title")}</h1>
      </div>

      <Periods value={per} onChange={choosePeriod} />

      {body}

      <details className="group rounded-xl border border-ink-700">
        <summary className="ui-label flex min-h-11 cursor-pointer list-none items-center gap-1.5 px-4 [&::-webkit-details-marker]:hidden">
          <ChevronRight className="h-4 w-4 shrink-0 transition-transform group-open:rotate-90" aria-hidden="true" />
          {t("spending.how.title")}
        </summary>
        <p className="border-t border-ink-700 px-4 py-4 text-sm leading-relaxed text-parchment-dim">{t("spending.how.text")}</p>
      </details>

      <div className="flex flex-wrap gap-3">
        <button type="button" className="btn btn-ghost max-w-full whitespace-normal" onClick={exportFile}>{t("spending.export")}</button>
        <button type="button" className="btn btn-ghost max-w-full whitespace-normal" onClick={() => setClearing(true)}>{t("spending.clear.open")}</button>
      </div>

      {/* The page's word in passing, at its foot: there before it has anything to say, as a screen
          reader only hears a change. */}
      <p role="status" className="min-h-5 text-center text-xs text-parchment-dim [overflow-wrap:anywhere]">
        {toast && <span key={toast.at} className="animate-fade">{toast.text}</span>}
      </p>

      {opened && !wide && summary && (
        <LineDetail
          key={`${opened.cut}:${opened.key}`}
          line={opened}
          range={range}
          per={per}
          since={summary.since}
          currency={summary.currency}
          beside={false}
          reread={reads}
          onClose={closeLine}
          onRepriced={readAgain}
          onForgot={forgot}
        />
      )}
      {clearing && <ClearSheet onClose={() => setClearing(false)} onCleared={cleared} />}
    </div>
  );
}

