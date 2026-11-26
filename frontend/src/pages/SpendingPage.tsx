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
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Navigate, useLocation, useNavigate, useSearchParams } from "react-router";

/** The page's side gutters: layout, not text, so in pixels at most (as on an AI's page). */
const GUTTER = "px-[min(1.5rem,24px)]";
/** From here the detail of a line stands beside the list rather than over it. */
const WIDE = "(min-width: 64rem)";
/** Long enough to read a line, as the conversation's own toasts. */
const TOAST_MS = 4200;
const PERIODS: readonly string[] = ["7", "30", "month", "last", "all"] satisfies Period[];
const CUTS: Cut[] = ["model", "card", "conversation", "use"];

/** The AI the lists are narrowed to, as it was when chosen: a period where it made no call keeps
 *  it chosen, under that name. */
type Chosen = { id: string; name: string; free: boolean };

/** The route /spending: what the AIs cost, by period and four cuts, as sums. Opening it asks the
 *  server once; a period or a filter, once; a line opened, once. `?per=` is the period of this
 *  visit only, until another is chosen; `?cut=&key=` is the line open, so that a reload keeps it
 *  and the back button closes it before it leaves the page. */
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

/** In place of what belongs to another question while this one is asked: as high as it was, so
 *  that nothing below it jumps, and no amount of it left in sight. A failure says so there. */
function Held({ waiting, room, failure, onRetry, className, children }: {
  waiting: boolean;
  room: number;
  failure: { error: unknown } | null;
  onRetry(): void;
  className?: string;
  children: ReactNode;
}) {
  const { t } = useI18n();
  if (!waiting) return <div className={className}>{children}</div>;
  return (
    <div className={className} aria-busy={!failure} style={{ minHeight: room }}>
      {failure
        ? <LoadFailure error={failure.error} onRetry={onRetry} />
        : <p className="text-mist animate-pulse-soft">{t("common.loading")}</p>}
    </div>
  );
}

function SpendingView() {
  const { t, locale } = useI18n();
  const spending = data.spending!;
  const navigate = useNavigate();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const wide = useWide();
  const filterId = useId();

  // The period the address asks, read once: the period of this visit does not become the one kept.
  const [asked] = useState(() => {
    const per = params.get("per");
    return per !== null && PERIODS.includes(per) ? (per as Period) : keptPeriod();
  });
  const addressCut = params.get("cut") as Cut | null;
  const addressKey = params.get("key");
  const [per, setPer] = useState<Period>(asked);
  const [cut, setCut] = useState<Cut>(() => (addressCut !== null && CUTS.includes(addressCut) ? addressCut : "model"));
  const [model, setModel] = useState<Chosen | null>(null);
  // Each answer with the question it answers: one of another period or AI is never shown as this one's.
  const [answer, setAnswer] = useState<{ period: string; model: string; summary: Spending } | null>(null);
  // A failure asked again is `again` until it is answered: no amount comes back, and no error stays.
  const [failure, setFailure] = useState<{ query: string; error: unknown; again?: boolean } | null>(null);
  // The room the total and the lists took when another question was asked, kept while it is.
  const [room, setRoom] = useState({ all: 0, list: 0 });
  // The name a line opened from the list shows before its detail is read, and whether to price it.
  const [hint, setHint] = useState<Opened | null>(null);
  const [clearing, setClearing] = useState(false);
  const [toast, setToast] = useState<{ text: string; at: number } | null>(null);
  // Each read of everything again: a line opened reads itself again with it.
  const [reads, setReads] = useState(0);
  // The day the page was opened, or read again: the periods end on it.
  const [today, setToday] = useState(() => new Date());
  const range = rangeOf(per, today);
  const { from, to } = range;
  const period = `${from ?? ""}/${to}`;
  const modelId = model?.id ?? "";
  const query = `${period}/${modelId}`;
  const allBox = useRef<HTMLDivElement>(null);
  const listBox = useRef<HTMLDivElement>(null);
  const scrollTo = useRef<string | null>(null);
  // A period chosen on this visit outlasts the address's: an entry gone back to still says `per`.
  const chosenHere = useRef(false);

  const opened: Opened | null = addressCut !== null && CUTS.includes(addressCut) && addressKey !== null
    ? hint && hint.cut === addressCut && hint.key === addressKey ? hint : { cut: addressCut, key: addressKey, name: "" }
    : null;

  const answered = useRef(0);
  const read = useCallback(() => {
    const mine = ++answered.current;
    const asking: SpendingQuery = { from, to, model: modelId || undefined };
    setFailure((before) => (before?.query === query ? { ...before, again: true } : before));
    spending.summary(asking).then(
      (found) => {
        if (mine !== answered.current) return;
        setAnswer({ period, model: modelId, summary: found });
        setFailure(null);
      },
      (error) => mine === answered.current && setFailure({ query, error }),
    );
  }, [spending, from, to, modelId, period, query]);
  useEffect(() => {
    read();
  }, [read, reads]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);
  const say = (text: string) => setToast({ text, at: performance.now() });

  // The line just closed, in sight in the list, once its sheet has gone, whichever way it went.
  const isOpen = opened !== null;
  useEffect(() => {
    if (isOpen || scrollTo.current === null) return;
    const key = scrollTo.current;
    scrollTo.current = null;
    requestAnimationFrame(() => {
      document.querySelector(`[data-cut-list] [data-key="${CSS.escape(key)}"]`)?.scrollIntoView({ block: "center" });
    });
  }, [isOpen]);

  /** The room the total and the lists take now, held while the next answer is awaited. What is
   *  already held keeps its room. */
  function holdRoom() {
    setRoom((before) => ({
      all: allBox.current?.offsetHeight ?? before.all,
      list: listBox.current?.offsetHeight ?? before.list,
    }));
  }

  /** Everything read again, today included: after a clear or a price that filled earlier calls. */
  function readAgain() {
    setReads((n) => n + 1);
    setToday(new Date());
  }

  /** The address without some of its words, in place: the entry stays what it was. */
  function dropFromAddress(...names: string[]) {
    setParams((before) => {
      const next = new URLSearchParams(before);
      for (const name of names) next.delete(name);
      return next;
    }, { replace: true, state: location.state });
  }

  function choosePeriod(next: Period) {
    if (next === per) return;
    keepPeriod(next);
    holdRoom();
    setPer(next);
    chosenHere.current = true;
  }

  // The period chosen is the device's now, not the address's: on this entry, and on any entry gone
  // back to, such as the one a line beside the list was opened from.
  const addressPer = params.has("per");
  useEffect(() => {
    if (chosenHere.current && addressPer) dropFromAddress("per");
  });

  function chooseModel(id: string) {
    holdRoom();
    if (!id) return setModel(null);
    const listed = answer?.summary;
    const free = listed?.free.find(([each]) => each === id);
    const name = free?.[1] ?? listed?.models.find(([each]) => each === id)?.[1] ?? id;
    setModel({ id, name, free: !!free });
  }

  function openLine(line: Opened) {
    setHint(line);
    setParams((before) => {
      const next = new URLSearchParams(before);
      next.set("cut", line.cut);
      next.set("key", line.key);
      return next;
    // A line opened here is an entry of its own, which the back button closes; one opened over
    // another takes its place.
    }, isOpen ? { replace: true, state: location.state } : { state: { line: true } });
  }

  function back() {
    if (location.key !== "default") navigate(-1);
    else navigate("/settings");
  }

  function closeLine() {
    scrollTo.current = opened?.key ?? null;
    if ((location.state as { line?: boolean } | null)?.line === true) navigate(-1);
    else dropFromAddress("cut", "key");
  }

  function forgot(which: "card" | "conversation", key: string) {
    setAnswer((before) => before && {
      ...before,
      summary: which === "conversation"
        ? { ...before.summary, conversations: before.summary.conversations.map((c) => (c[0] === key ? [c[0], null, ...c.slice(2)] as typeof c : c)) }
        : { ...before.summary, cards: before.summary.cards.map((c) => (c[0] === key ? [c[0], null, ...c.slice(2)] as typeof c : c)) },
    });
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

  const summary = answer?.summary ?? null;
  const failed = failure?.query === query ? failure : null;
  // What is said in place of what failed: nothing while it is asked again.
  const said = failed && !failed.again ? failed : null;
  const money = (cost: number, unpriced = 0) =>
    moneyText({ cost, unpriced, currency: summary?.currency ?? "USD" }, "total", locale, t);
  const since = summary ? localDate(new Date(summary.since)) : "";
  const choices = summary ? [
    ...summary.models.map(([id, name]) => [id, name] as const),
    ...summary.free.map(([id, name]) => [id, name] as const),
  ].filter((choice): choice is readonly [string, string | null] => choice[0] !== null) : [];
  // The AI chosen stays a choice where it made no call: what the select shows is what is asked.
  if (model && !choices.some(([id]) => id === model.id)) choices.push([model.id, model.name]);

  let body: ReactNode;
  if (!answer) {
    body = said
      ? <LoadFailure error={said.error} onRetry={read} />
      : <p aria-busy="true" className="text-mist animate-pulse-soft">{t("common.loading")}</p>;
  } else {
    const shown = answer.summary;
    const empty = shown.calls === 0;
    // Another period asked, or this one read again and failed: none of these amounts is its own.
    const periodWaits = answer.period !== period || (failed !== null && answer.model === modelId);
    const listWaits = !periodWaits && answer.model !== modelId;
    const free = model !== null && (shown.free.some(([id]) => id === model.id)
      || (model.free && !shown.models.some(([id]) => id === model.id)));
    body = (
      <Held waiting={periodWaits} room={room.all} failure={said} onRetry={read} className="flex flex-col gap-6">
        <div ref={allBox} className="flex flex-col gap-6">
          <section className="flex flex-col gap-1.5">
            <p data-total className="font-display text-4xl font-semibold text-parchment [overflow-wrap:anywhere]">
              {money(shown.total, shown.unpriced.calls)}
            </p>
            {!empty && shown.outside_replies.calls > 0 && (
              <button
                type="button"
                data-outside
                className="inline-flex min-h-11 items-center self-start text-left text-sm text-mist underline-offset-2 hover:text-parchment hover:underline"
                onClick={() => setCut("use")}
              >
                {t("spending.outside", { money: amountText(shown.outside_replies.cost, shown.currency, locale, t) })}
              </button>
            )}
            {!empty && shown.previous !== null && from !== undefined && (
              <p className="text-sm text-mist">
                {t("spending.previous", { count: daysOf({ from, to }), money: amountText(shown.previous, shown.currency, locale, t) })}
              </p>
            )}
            {(from === undefined || from < since) && (
              <p className="text-sm text-mist">{t("spending.since", { date: dayMonth(shown.since, locale) })}</p>
            )}
            {empty && <p className="text-sm text-parchment-dim">{t("spending.nothing")}</p>}
          </section>

          {!empty && (
            <>
              <Bars key={`${per}:${from}:${to}:${reads}`} series={shown.series} currency={shown.currency} />

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
                      value={modelId}
                      onChange={(e) => chooseModel(e.target.value)}
                    >
                      <option value="">{t("spending.filter.all")}</option>
                      {choices.map(([id, name]) => <option key={id} value={id}>{name ?? id}</option>)}
                    </select>
                    {model && !listWaits && shown.model_total !== null && (
                      <p className="text-sm text-parchment-dim [overflow-wrap:anywhere]">
                        {t("spending.filter.with", {
                          name: model.name,
                          // A free AI never has an amount, not even nothing.
                          money: free
                            ? t("ai.free")
                            : moneyText({
                              cost: shown.model_total,
                              unpriced: shown.models.find(([id]) => id === model.id)?.[10] ?? 0,
                              currency: shown.currency,
                            }, "line", locale, t),
                        })}
                      </p>
                    )}
                  </div>
                )}
              </section>

              <div className={clsx(wide && opened && "grid grid-cols-[minmax(0,1fr)_minmax(0,24rem)] items-start gap-6")}>
                <Held waiting={listWaits} room={room.list} failure={said} onRetry={read}>
                  <div ref={listBox}>
                    <CutList summary={shown} cut={cut} onOpen={openLine} />
                  </div>
                </Held>
                {opened && wide && (
                  <LineDetail
                    key={`${opened.cut}:${opened.key}`}
                    line={opened}
                    range={range}
                    per={per}
                    since={shown.since}
                    currency={shown.currency}
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
        </div>
      </Held>
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
