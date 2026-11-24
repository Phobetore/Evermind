import { Tag } from "@/components/ui/Tag";
import { useI18n } from "@/i18n/I18nProvider";
import {
  ageLine, freeOnly, isNew, pages, priceLine, readsLine, search, searchable, sortRows, suggestions,
  type SortKey,
} from "@/lib/ai";
import type { Family, ProbeModel, ProbeResult } from "@/types";
import { clsx } from "clsx";
import { RefreshCw } from "lucide-react";
import { useDeferredValue, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { HOSTED_FAMILIES, LOCAL_FAMILIES, type Answer } from "./addFlow";

/** Rows drawn at a time: a keystroke never lays out more, whatever the list holds. */
const SLICE = 30;
/** Under this many rows, a search is more to read than the list itself. */
const SEARCH_FROM = 12;
/** What Evermind counts for a local server that does not say the size it loads (ai_call.window). */
const LOCAL_ASSUMED = 4_096;
/** What it counts when nothing at all is said: the default of the form before AIs. */
const UNTOLD = 16_384;
/** The answers to « How much can it read at once? », in tokens. */
const SIZES = [["sizeFew", 8_000], ["sizeSome", 32_000], ["sizeMany", 128_000]] as const;
/** The field's edge stays stuck alone above this root size: with the row as well, a phone at a very
 *  large text size would show no result at all. */
const HUGE_ROOT_PX = 24;
/** A tap on a row blurs the field before it lands: the row and the count come back a moment later,
 *  so that nothing moves under the finger between its press and its release. */
const SHOW_AFTER_BLUR_MS = 250;

/** A row for a name typed as it is: the service says what it is once asked. */
function typedRow(id: string): ProbeModel {
  return {
    id, name: id, vendor: null, created: null, context: { served: null, configured: null, max: null },
    max_output: null, price: { input: null, output: null, varies: false, cache_read: null, cache_write: null },
    reasons: null,
  };
}

const priced = (row: ProbeModel) => row.price.input !== null && row.price.output !== null;

export function ModelPickList({
  list, service, have, picked, typed, answers, onPick, onUseAsIs, onAnswer, onReread, extra,
}: {
  /** Null when the name is typed by hand: no row, no sort, no filter, the search field alone. */
  list: ProbeResult | null;
  service: { name: string; family: Family };
  have: Set<string>;
  picked: string[];
  typed: string[];
  answers: Record<string, Answer>;
  onPick(id: string): void;
  onUseAsIs(id: string): void;
  onAnswer(id: string, answer: Answer): void;
  onReread(): void;
  /** Room under a row for what a later plan adds (its estimate of a message's cost). */
  extra?(row: ProbeModel): React.ReactNode;
}) {
  const { t, locale } = useI18n();
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("service");
  const [freeShown, setFreeShown] = useState(false);
  // The rows ticked when « Ticked » was turned on: one untouched there stays, to be ticked again.
  const [tickedOnly, setTickedOnly] = useState<Set<string> | null>(null);
  const tickedShown = tickedOnly !== null;
  const [focused, setFocused] = useState(false);
  // Once the field is typed in, the list holds at least the height of the box it scrolls in: with a
  // single result, the box could not stay scrolled, and the field, then the row under the finger,
  // would drop. Kept after the field lets go, for the same row; given back when the sort or a chip
  // changes the view, never sooner: given back under a lone row, the row would drop.
  const [room, setRoom] = useState<number | null>(null);
  const shownAgain = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The row kept in place as the sort and the count come back, and where it was.
  const held = useRef<{ row: Element; at: number } | null>(null);
  // The row last pressed: on a phone a tapped box does not always take the focus (Safari gives none).
  const touched = useRef<Element | null>(null);
  const whole = useRef<HTMLDivElement>(null);
  const rowList = useRef<HTMLUListElement>(null);
  const top = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const sentinel = useRef<HTMLLIElement>(null);
  const searchId = useId();
  const [huge] = useState(() => parseFloat(getComputedStyle(document.documentElement).fontSize) >= HUGE_ROOT_PX);
  const [now, setNow] = useState(() => Date.now());

  // The list's age, said again each minute while it is on screen.
  useEffect(() => {
    const ticking = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(ticking);
  }, []);
  useEffect(() => () => {
    if (shownAgain.current) clearTimeout(shownAgain.current);
  }, []);

  const rows = useMemo(() => list?.models ?? [], [list]);
  // Made once per list: a keystroke only compares.
  const made = useMemo(() => rows.map((row) => searchable(row, list?.read_at ?? "", t)), [rows, list, t]);
  const typedMade = useMemo(() => typed.map((id) => searchable(typedRow(id), "", t)), [typed, t]);
  const collator = useMemo(() => new Intl.Collator(locale, { sensitivity: "base", numeric: true }), [locale]);
  const ticked = useMemo(() => new Set(picked), [picked]);

  // The list follows the field a frame late, so that typing never waits for it.
  const asked = useDeferredValue(query);
  const anyPrice = rows.some(priced);
  const anyDate = rows.some((row) => row.created !== null);

  const view = useMemo(() => {
    const keep = (row: ProbeModel) => (!freeShown || freeOnly(row)) && (tickedOnly === null || tickedOnly.has(row.id));
    // « Ticked » shows every ticked row, whatever was searched before: typing turns it off.
    const sought = tickedOnly !== null ? "" : asked;
    const found = search(made, sought);
    const listed = sortRows(found, sort, collator).filter(keep);
    const typedFound = search(typedMade, sought).map((hit) => hit.row).filter(keep);
    return { found: found.length, listed, all: [...typedFound, ...listed] };
  }, [made, typedMade, asked, sort, collator, freeShown, tickedOnly]);

  // Every change of what is shown starts again from the first slice.
  const viewKey = `${asked}\u0000${sort}\u0000${freeShown}\u0000${tickedShown}\u0000${list?.read_at ?? ""}`;
  const [slice, setSlice] = useState({ key: viewKey, count: SLICE });
  const drawn = slice.key === viewKey ? slice.count : SLICE;
  const visible = view.all.slice(0, drawn);
  const more = view.all.length > drawn;

  useEffect(() => {
    const end = sentinel.current;
    if (!end || !more) return;
    const watcher = new IntersectionObserver((seen) => {
      if (seen.some((entry) => entry.isIntersecting)) setSlice({ key: viewKey, count: drawn + SLICE });
    }, { rootMargin: "200px" });
    watcher.observe(end);
    return () => watcher.disconnect();
  }, [viewKey, drawn, more]);

  /** The box that scrolls, which the stuck block sticks to: moved alone, the page behind stays still. */
  function scroller(): HTMLElement | null {
    let box = top.current?.parentElement ?? null;
    while (box && getComputedStyle(box).overflowY !== "auto" && getComputedStyle(box).overflowY !== "scroll") {
      box = box.parentElement;
    }
    return box;
  }

  // The sort and the count come back above the rows: the box scrolls by what they push down, so no row
  // moves under the finger, unless the block back on top would cover it: then it sits just under the
  // block. The browser does not do it here: the dialog follows no line (Modal's `tall`).
  useLayoutEffect(() => {
    const was = held.current;
    if (focused || !was) return;
    const box = scroller();
    const block = top.current?.nextElementSibling;
    if (!box || !block || !whole.current || !was.row.isConnected) {
      held.current = null;
      return;
    }
    const by = was.row.getBoundingClientRect().top - Math.max(was.at, block.getBoundingClientRect().bottom);
    const short = box.scrollTop + by - (box.scrollHeight - box.clientHeight);
    // Not enough below to scroll that far: the list first takes the room it lacks.
    if (short > 0.5) {
      setRoom(whole.current.offsetHeight + Math.ceil(short));
      return;
    }
    held.current = null;
    box.scrollTop += by;
  }, [focused, room]);

  /** The row to keep in place, and where it is now: the one just touched, else the one with the focus,
   *  else the first whose top is under the stuck block. */
  function holdRow() {
    held.current = null;
    const noted = touched.current;
    touched.current = null;
    const list = rowList.current;
    const block = top.current?.nextElementSibling;
    if (!block || !list) return;
    const focusedRow = document.activeElement?.closest("li");
    let row: Element | null | undefined = noted?.isConnected ? noted
      : focusedRow && list.contains(focusedRow) ? focusedRow : null;
    if (!row) {
      const edge = block.getBoundingClientRect().bottom;
      row = [...list.children].find((li) => li.getBoundingClientRect().top >= edge);
    }
    held.current = row ? { row, at: row.getBoundingClientRect().top } : null;
  }

  /** Back to the top of the results: the field at the top of the screen, the first result under it.
   *  Only when the view has gone past it: above, the title stays in sight. */
  function toTop(always = false) {
    const mark = top.current;
    const box = scroller();
    if (!mark || !box) return;
    const past = mark.getBoundingClientRect().top - box.getBoundingClientRect().top;
    if (always ? past !== 0 : past < 0) box.scrollTop += past;
  }

  /** The sort or a chip shows other rows: the room kept for the search goes, and the view goes back up. */
  function otherView() {
    setRoom(null);
    toTop();
  }

  function changeQuery(value: string) {
    setQuery(value);
    // Typing looks through the whole list again.
    setTickedOnly(null);
    toTop();
  }

  const n = rows.length;
  const hidden = list !== null && view.listed.length !== n;
  const countLine = list && (
    hidden
      ? t("ai.list.shown", { shown: view.listed.length, count: n })
        + (tickedShown ? t("ai.list.tickedOnly") : freeShown ? t("ai.list.freeOnly") : "")
      : t("ai.list.count", { count: n }) + (list.dropped.batch > 0 ? t("ai.list.batch", { count: list.dropped.batch }) : "")
  );
  const searchShown = list === null || n >= SEARCH_FROM;
  const q = tickedShown ? "" : asked.trim();
  const nothing = q !== "" && view.found === 0 && !typed.includes(q) && view.all.length === 0;

  const controls = list && (
    <div className="flex flex-col gap-2 pb-2">
      <div className="flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor={`${searchId}-sort`}>{t("ai.list.sort")}</label>
        <select
          id={`${searchId}-sort`}
          className="field !w-auto min-h-11 !py-1.5 text-sm"
          value={sort}
          onChange={(e) => {
            setSort(e.target.value as SortKey);
            otherView();
          }}
        >
          <option value="service">{t("ai.list.sortService")}</option>
          {anyDate && <option value="newest">{t("ai.list.sortNewest")}</option>}
          {anyPrice && <option value="cheapest">{t("ai.list.sortCheapest")}</option>}
          <option value="reads">{t("ai.list.sortReads")}</option>
          <option value="name">{t("ai.list.sortName")}</option>
        </select>
        {anyPrice && (
          <button
            type="button"
            aria-pressed={freeShown}
            className={clsx("btn !px-3 !py-1.5 text-sm", freeShown ? "btn-primary" : "btn-ghost")}
            onClick={() => {
              setFreeShown(!freeShown);
              otherView();
            }}
          >
            {t("ai.list.free")}
          </button>
        )}
        <button
          type="button"
          aria-pressed={tickedShown}
          className={clsx("btn !px-3 !py-1.5 text-sm", tickedShown ? "btn-primary" : "btn-ghost")}
          disabled={picked.length === 0 && !tickedShown}
          onClick={() => {
            setTickedOnly(tickedShown ? null : new Set(picked));
            otherView();
          }}
        >
          {t("ai.list.ticked", { count: picked.length })}
        </button>
      </div>
      <p className="text-xs text-mist" role="status">{countLine}</p>
    </div>
  );

  return (
    <div ref={whole} className="min-w-0" style={room !== null ? { minHeight: room } : undefined}>
      <div ref={top} />
      {/* Stuck at the box's own edge, over its padding: no row shows above it. */}
      <div className="sticky -top-4 z-10 -mx-4 bg-ink-900 px-4 pt-2 sm:-top-6 sm:-mx-6 sm:px-6">
        {searchShown && (
          <div className="relative mb-2">
            <label className="sr-only" htmlFor={searchId}>{t("ai.list.search")}</label>
            <input
              ref={field}
              id={searchId}
              type="search"
              inputMode="search"
              enterKeyHint="search"
              autoComplete="off"
              spellCheck={false}
              className={clsx("field", focused && list && "pr-16")}
              placeholder={t("ai.list.search")}
              value={query}
              onChange={(e) => changeQuery(e.target.value)}
              onFocus={() => {
                if (shownAgain.current) clearTimeout(shownAgain.current);
                touched.current = null;
                setFocused(true);
                setRoom(scroller()?.clientHeight ?? null);
                // After the browser's own move of a focused field into sight, which would undo this one.
                requestAnimationFrame(() => requestAnimationFrame(() => toTop(true)));
              }}
              onBlur={() => {
                shownAgain.current = setTimeout(() => {
                  holdRow();
                  setFocused(false);
                }, SHOW_AFTER_BLUR_MS);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
            />
            {focused && list && (
              <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-mist" aria-hidden>
                {view.listed.length.toLocaleString(locale)}
              </span>
            )}
          </div>
        )}
        {!huge && !focused && controls}
      </div>
      {huge && !focused && controls}

      {list === null && <p className="mb-3 text-sm text-mist">{t("ai.add.byHandHint")}</p>}

      <ul
        ref={rowList}
        className="flex flex-col gap-2"
        onPointerDown={(e) => {
          touched.current = (e.target as Element).closest("li");
        }}
      >
        {visible.map((row) => (
          <Row
            key={row.id}
            row={row}
            typedByHand={typed.includes(row.id)}
            readAt={list?.read_at ?? ""}
            service={service}
            online={list ? !list.local : HOSTED_FAMILIES.has(service.family)}
            already={have.has(row.id)}
            ticked={ticked.has(row.id)}
            answer={answers[row.id] ?? {}}
            onPick={onPick}
            onAnswer={onAnswer}
            extra={extra}
          />
        ))}
        {more && <li ref={sentinel} aria-hidden className="h-px" />}
      </ul>

      {nothing && list && (
        <div className="mt-3 flex flex-col items-start gap-2">
          <p className="text-sm text-parchment-dim">{t("ai.list.none", { query: q })}</p>
          {suggestions(made, q).map((name) => (
            <button
              key={name}
              type="button"
              className="btn btn-ghost !py-1.5 text-sm"
              onClick={() => {
                setQuery(name);
                toTop();
              }}
            >
              {t("ai.list.didYouMean", { name })}
            </button>
          ))}
        </div>
      )}
      {q !== "" && view.found === 0 && !typed.includes(q) && (
        <div className="mt-2 flex flex-col items-start gap-1">
          <button type="button" className="btn btn-ghost !py-1.5 text-sm" onClick={() => onUseAsIs(q)}>
            {t("ai.list.useAsIs", { query: q })}
          </button>
          <p className="text-xs text-mist">{t("ai.list.useAsIsHint")}</p>
        </div>
      )}

      {list && (
        <div className="mt-4 flex flex-wrap items-center gap-3 text-xs text-mist">
          <span>{ageLine(list.read_at, now, t)}</span>
          <button type="button" className="btn btn-ghost !px-3 !py-1 text-xs" onClick={onReread}>
            <RefreshCw className="h-3.5 w-3.5" />
            {t("ai.list.reread")}
          </button>
        </div>
      )}
    </div>
  );
}

function Row({
  row, typedByHand, readAt, service, online, already, ticked, answer, onPick, onAnswer, extra,
}: {
  row: ProbeModel;
  typedByHand: boolean;
  readAt: string;
  service: { name: string; family: Family };
  /** A paid service, or any address not at home: its price may be asked. */
  online: boolean;
  already: boolean;
  ticked: boolean;
  answer: Answer;
  onPick(id: string): void;
  onAnswer(id: string, answer: Answer): void;
  extra?(row: ProbeModel): React.ReactNode;
}) {
  const { t } = useI18n();
  const local = LOCAL_FAMILIES.has(service.family);
  const { served, configured, max } = row.context;
  const told = served ?? configured;
  // A server that loads a size of its own and has not said which: what Evermind counts until it does.
  let sizeNote: string | null = null;
  let reads: number | null = told ?? max;
  if (local && told === null) {
    reads = null;
    sizeNote = max === null && service.family === "ollama"
      ? t("ai.list.sizeAtAdd")
      : t("ai.list.sizeUntold", { size: max === null ? LOCAL_ASSUMED : Math.min(max, LOCAL_ASSUMED) });
  }
  const priceShown = priced(row) || row.price.varies;
  const line = [
    row.vendor,
    sizeNote === null && !typedByHand ? readsLine(reads, t) : null,
    priceShown
      ? priceLine({ read_in: row.price.input, read_out: row.price.output, own_in: null, own_out: null, varies: row.price.varies }, freeOnly(row), t)
      : null,
  ].filter(Boolean).join(" · ");
  const asksSize = ticked && !local && served === null && configured === null && max === null;
  const asksPrice = ticked && online && !priced(row) && !row.price.varies;

  return (
    <li className={clsx("rounded-xl border", ticked ? "border-ember-600/50 bg-ember-glow/40" : "border-ink-700")}>
      <label
        className={clsx(
          "flex min-h-14 items-start gap-3 px-3 py-2.5",
          already ? "cursor-default opacity-70" : "cursor-pointer",
        )}
      >
        <input
          type="checkbox"
          className="mt-1 h-5 w-5 shrink-0 accent-[#e29a3e]"
          checked={ticked || already}
          disabled={already}
          onChange={() => onPick(row.id)}
        />
        <span className="min-w-0 flex-1">
          <span className="line-clamp-2 font-display text-sm font-medium text-parchment [overflow-wrap:anywhere]">{row.name}</span>
          <span className="block font-mono text-[0.7rem] text-mist-dim [overflow-wrap:anywhere]">{row.id}</span>
          {line && <span className="mt-0.5 block text-xs text-mist [overflow-wrap:anywhere]">{line}</span>}
          {sizeNote && <span className="mt-0.5 block text-xs text-mist">{sizeNote}</span>}
          <span className="mt-1 flex flex-wrap gap-1.5 empty:hidden">
            {row.reasons === true && <Tag tone="arcane" className="whitespace-normal">{t("ai.thinks")}</Tag>}
            {freeOnly(row) && <Tag className="whitespace-normal">{t("ai.free")}</Tag>}
            {isNew(row, readAt) && <Tag tone="ember" className="whitespace-normal">{t("ai.new")}</Tag>}
            {typedByHand && <Tag className="whitespace-normal">{t("ai.typedByHand")}</Tag>}
            {already && <Tag className="whitespace-normal">{t("ai.list.already")}</Tag>}
          </span>
          {extra?.(row)}
        </span>
      </label>
      {asksSize && <SizeQuestion id={row.id} answer={answer} onAnswer={onAnswer} />}
      {asksPrice && <PriceFields id={row.id} service={service.name} answer={answer} onAnswer={onAnswer} />}
    </li>
  );
}

function SizeQuestion({ id, answer, onAnswer }: { id: string; answer: Answer; onAnswer(id: string, answer: Answer): void }) {
  const { t } = useI18n();
  const name = useId();
  const chosen = answer.context_own ?? null;
  const options: [string, number | null][] = [...SIZES.map(([key, tokens]) => [t(`ai.list.${key}`, { count: pages(tokens) }), tokens] as [string, number]), [t("ai.list.sizeUnknown"), null]];
  return (
    <fieldset className="border-t border-ink-700 px-3 py-2.5">
      <legend className="sr-only">{t("ai.list.sizeQuestion")}</legend>
      <p className="mb-1.5 text-sm text-parchment-dim" aria-hidden>{t("ai.list.sizeQuestion")}</p>
      <div className="flex flex-col gap-1">
        {options.map(([label, tokens]) => (
          <label key={label} className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-parchment-dim">
            <input
              type="radio"
              name={name}
              className="h-4 w-4 accent-[#e29a3e]"
              checked={chosen === tokens}
              onChange={() => onAnswer(id, { context_own: tokens })}
            />
            {label}
          </label>
        ))}
      </div>
      <p className="mt-1 text-xs text-mist">
        {chosen === null ? t("ai.list.sizeUnknownHint", { tokens: UNTOLD, count: pages(UNTOLD) }) : t("ai.list.sizeNoted")}
      </p>
    </fieldset>
  );
}

/** A price typed with a comma or a point; anything else is no price. */
function priceOf(text: string): number | null {
  const plain = text.trim().replace(",", ".");
  if (plain === "") return null;
  const value = Number(plain);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function PriceFields({ id, service, answer, onAnswer }: { id: string; service: string; answer: Answer; onAnswer(id: string, answer: Answer): void }) {
  const { t } = useI18n();
  const ids = useId();
  // As typed: "3," is on its way to "3,5", and a number would lose the comma.
  const [read, setRead] = useState(() => answer.price_own_in?.toString() ?? "");
  const [written, setWritten] = useState(() => answer.price_own_out?.toString() ?? "");
  return (
    <div className="border-t border-ink-700 px-3 py-2.5">
      <p className="mb-1.5 text-sm text-parchment-dim">{t("ai.list.priceTitle")}</p>
      <div className="flex gap-3">
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-mist" htmlFor={`${ids}-in`}>
          {t("ai.list.priceIn")}
          <input
            id={`${ids}-in`}
            className="field"
            inputMode="decimal"
            autoComplete="off"
            value={read}
            onChange={(e) => {
              setRead(e.target.value);
              onAnswer(id, { price_own_in: priceOf(e.target.value) });
            }}
          />
        </label>
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-mist" htmlFor={`${ids}-out`}>
          {t("ai.list.priceOut")}
          <input
            id={`${ids}-out`}
            className="field"
            inputMode="decimal"
            autoComplete="off"
            value={written}
            onChange={(e) => {
              setWritten(e.target.value);
              onAnswer(id, { price_own_out: priceOf(e.target.value) });
            }}
          />
        </label>
      </div>
      <p className="mt-1 text-xs text-mist">{t("ai.list.priceHint", { service })}</p>
    </div>
  );
}
