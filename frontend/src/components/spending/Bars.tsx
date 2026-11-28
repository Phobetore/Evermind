import { useI18n } from "@/i18n/I18nProvider";
import { amountText } from "@/lib/spending";
import { dayMonth } from "@/lib/utils";
import type { Spending } from "@/types";
import { clsx } from "clsx";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useRef, useState } from "react";

/** How far a press may stray and still be a tap, in pixels. */
const SLOP = 10;

/** A bar for each day or week of the period: the replies, and the rest, over one another, the
 *  dearest the full height. A bar is chosen by a tap, by sliding along them, or step by step with
 *  the two buttons; the line under them says it. The bars are a picture only: the line is what a
 *  screen reader hears. The parent gives it a key of its period, so that a new one starts on its
 *  last bar. */
export function Bars({ series, currency }: { series: Spending["series"]; currency: string }) {
  const { t, locale } = useI18n();
  const points = series.points;
  const [at, setAt] = useState(points.length - 1);
  const area = useRef<HTMLDivElement>(null);
  // Where the finger or the mouse went down, until it is known whether it taps, slides along the
  // bars, or scrolls the page; then whether it slides.
  const press = useRef<{ x: number; y: number; sliding: boolean } | null>(null);
  const highest = points.reduce((most, [, replies, other]) => Math.max(most, replies + other), 0);

  /** The bar under a finger, or the nearest to it beside the bars. */
  function nearest(x: number): number {
    const box = area.current!.getBoundingClientRect();
    const i = Math.floor(((x - box.left) / box.width) * points.length);
    return Math.min(points.length - 1, Math.max(0, i));
  }

  const shown = points[Math.min(at, points.length - 1)];
  const legend = shown && t(series.step === "week" ? "spending.bars.week" : "spending.bars.day", {
    date: dayMonth(shown[0], locale),
    money: amountText(shown[1] + shown[2], currency, locale, t),
  });
  const step = "flex size-[44px] shrink-0 items-center justify-center rounded-lg text-mist hover:text-parchment disabled:opacity-40";

  return (
    <div role="group" aria-label={t(series.step === "week" ? "spending.bars.labelWeeks" : "spending.bars.label")} className="flex flex-col gap-1">
      <div
        ref={area}
        data-bars
        aria-hidden
        // Sideways belongs to the bars; up and down still scroll the page.
        className="flex h-[96px] touch-pan-y items-end gap-px select-none"
        onPointerDown={(e) => {
          press.current = { x: e.clientX, y: e.clientY, sliding: false };
        }}
        onPointerMove={(e) => {
          const now = press.current;
          if (!now) return;
          if (!now.sliding) {
            const across = Math.abs(e.clientX - now.x);
            const down = Math.abs(e.clientY - now.y);
            if (Math.max(across, down) < SLOP) return;
            // Up or down is the page's: it scrolls, and the choice stays where it was.
            if (across <= down) {
              press.current = null;
              return;
            }
            now.sliding = true;
            area.current!.setPointerCapture?.(e.pointerId);
          }
          setAt(nearest(e.clientX));
        }}
        onPointerUp={(e) => {
          // A tap: a press that went nowhere chooses the bar under it.
          if (press.current && !press.current.sliding) setAt(nearest(e.clientX));
          press.current = null;
        }}
        onPointerCancel={() => (press.current = null)}
      >
        {points.map(([start, replies, other], i) => (
          <div
            key={start}
            data-bar
            className={clsx("flex h-full min-w-0 flex-1 flex-col justify-end rounded-sm", i === at && "bg-ink-800")}
          >
            <div className={clsx(i === at ? "bg-ember-300" : "bg-ink-500")} style={{ height: highest ? `${(other / highest) * 100}%` : 0 }} />
            <div className={clsx("rounded-b-sm", i === at ? "bg-ember-400" : "bg-ember-600")} style={{ height: highest ? `${(replies / highest) * 100}%` : 0 }} />
          </div>
        ))}
      </div>
      <div className="flex items-center gap-1">
        <button type="button" className={step} aria-label={t("spending.bars.before")} disabled={at <= 0} onClick={() => setAt(at - 1)}>
          <ChevronLeft className="h-5 w-5" aria-hidden />
        </button>
        <p data-bars-legend aria-live="polite" className="min-w-0 flex-1 text-center text-sm text-parchment-dim break-words">
          {legend}
        </p>
        <button type="button" className={step} aria-label={t("spending.bars.after")} disabled={at >= points.length - 1} onClick={() => setAt(at + 1)}>
          <ChevronRight className="h-5 w-5" aria-hidden />
        </button>
      </div>
    </div>
  );
}
