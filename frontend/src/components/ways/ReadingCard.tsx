import { BUILT_IN } from "@/engine";
import { useI18n } from "@/i18n/I18nProvider";
import { estimateOf, estimateText, pages, readerOfAi, readingOf, type Reader, type Reading } from "@/lib/estimate";
import { wayName } from "@/lib/ways";
import type { Ai, WayFields } from "@/types";
import { useId, useState } from "react";

/** The margin of a reading capacity nothing has measured: 6 % of it, never under 200. */
const WIDE_MARGIN = 0.06;
const LEAST_MARGIN = 200;

/** A capacity the source says, with no AI of its own: read as the engine counts, the reply's room
 *  taken whole, and no price. */
function readerOfWindow(window: number): Reader {
  return {
    window,
    margin: Math.max(LEAST_MARGIN, Math.trunc(window * WIDE_MARGIN)),
    ratio: 1,
    reserve: (room) => room ?? 0,
    replyTokens: { short: null, medium: null, long: null },
    reasons: null,
    thinkingMeasured: false,
    pricing: null,
  };
}

/** The room kept for the reply: hatched, as it is room left, not text read. */
const HATCHED = { background: "repeating-linear-gradient(135deg, var(--color-mist-dim) 0 3px, transparent 3px 6px)" };

/** The default first, then the others as listed. */
const inOrder = (ais: Ai[]) => [...ais.filter((ai) => ai.is_default), ...ais.filter((ai) => !ai.is_default)];

/** What an AI would read of a long story under a way: the pages sent with each message, the
 *  share of each part, whether its capacity is full and what Light would do then, and what 100
 *  messages would cost. `ais` null: an edition with no AIs of its own, which says only what the
 *  way asks, unless the source says a capacity (`hostWindow`). */
export function ReadingCard({ way, ais, hostWindow }: { way: WayFields; ais: Ai[] | null; hostWindow: number | null }) {
  const { t, locale } = useI18n();
  const ids = useId();
  const [chosen, setChosen] = useState<string | null>(null);
  const listed = ais && inOrder(ais);
  const ai = listed && (listed.find((each) => each.id === chosen) ?? listed[0] ?? null);

  let body: React.ReactNode;
  if (listed && listed.length === 0) {
    body = <p className="text-sm text-mist">{t("ways.card.noAi")}</p>;
  } else if (ai) {
    const reader = readerOfAi(ai);
    const reading = readingOf(reader, way);
    const light = readingOf(reader, BUILT_IN.light as WayFields);
    body = (
      <>
        <Lines reading={reading} window={ai.context.used} name={ai.name} />
        {reading.full && (reading.reread ?? 0) < (light.reread ?? 0) && (
          <p className="text-sm text-ember-300">
            {t("ways.card.lighter", { name: wayName({ id: "light", name: null }, t), count: light.reread ?? 0 })}
          </p>
        )}
        <p className="text-sm text-parchment-dim">
          {estimateText(estimateOf(reader, way), locale, t)}{" "}
          <small className="text-xs text-mist">{t("ways.card.reference")}</small>
        </p>
      </>
    );
  } else if (hostWindow !== null) {
    body = <Lines reading={readingOf(readerOfWindow(hostWindow), way)} window={hostWindow} name={null} />;
  } else {
    body = (
      <p className="text-sm text-parchment-dim">
        {way.history_limit === 0 ? t("ways.card.askedAll") : t("ways.card.askedOnly", { count: way.history_limit })}
      </p>
    );
  }

  return (
    <section className="panel flex flex-col gap-3 px-[min(1.25rem,20px)] py-4" aria-labelledby={`${ids}-title`}>
      <h2 id={`${ids}-title`} className="ui-label">{t("ways.card.title")}</h2>
      {listed && listed.length > 0 && ai && (
        // The select under its label, the card's whole width to itself: a select never wraps, and
        // beside the label a long name, or any at a large text size, would be cut.
        <div className="flex min-w-0 flex-col gap-1.5">
          <label htmlFor={`${ids}-ai`} className="text-sm text-mist">{t("ways.card.with")}</label>
          <select
            id={`${ids}-ai`}
            className="field min-h-11 !py-1.5 text-sm"
            value={ai.id}
            onChange={(e) => setChosen(e.target.value)}
          >
            {listed.map((each) => <option key={each.id} value={each.id}>{each.name}</option>)}
          </select>
        </div>
      )}
      {body}
    </section>
  );
}

/** The pages sent and read, the bar of the parts and its key, and the sentence of a full capacity. */
function Lines({ reading, window, name }: { reading: Reading; window: number; name: string | null }) {
  const { t } = useI18n();
  const { parts } = reading;
  const width = (tokens: number) => `${Math.min(100, (tokens / window) * 100).toFixed(2)}%`;
  const segments = [
    { key: "card", tokens: parts.card, className: "bg-arcane-500" },
    { key: "reminders", tokens: parts.reminders, className: "bg-arcane-300" },
    { key: "history", tokens: parts.history, className: "bg-mist" },
    { key: "room", tokens: parts.room, className: "" },
  ] as const;
  return (
    <>
      <p className="font-display text-base text-parchment">{t("ways.card.sent", { pages: reading.pages })}</p>
      {name !== null && <p className="text-sm text-parchment-dim">{t("ways.card.reads", { name, pages: pages(window) })}</p>}
      {/* The words are in the key under it: the bar only draws them. */}
      <div aria-hidden="true" className="flex h-3 overflow-hidden rounded-full bg-ink-700">
        {segments.map((segment) => (
          <i key={segment.key} className={`block h-full ${segment.className}`} style={{ width: width(segment.tokens), ...(segment.key === "room" ? HATCHED : {}) }} />
        ))}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-mist">
        {segments.map((segment) => (
          <li key={segment.key} className="flex items-center gap-1.5">
            <span aria-hidden="true" className={`h-2.5 w-2.5 shrink-0 rounded-sm ${segment.className}`} style={segment.key === "room" ? HATCHED : undefined} />
            {t(`ways.bar.${segment.key}`)}
          </li>
        ))}
      </ul>
      {reading.full && (
        <p className="text-sm text-parchment-dim">
          {reading.asked === null
            ? t("ways.card.fullAll", { read: reading.reread ?? 0 })
            : t("ways.card.full", { read: reading.reread ?? 0, asked: reading.asked })}
        </p>
      )}
    </>
  );
}
