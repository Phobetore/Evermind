import { data, type DataSource } from "@/data";
import { useI18n, type Translate } from "@/i18n/I18nProvider";
import { moneyText, spendingShown } from "@/lib/spending";
import type { SpentTotal } from "@/types";
import { ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";

type Query = { model?: string; card?: string; conversation?: string; days: 30 | "all" };

/** What one AI, one character, one conversation, or everything has cost, as a line that opens
 *  Spending on it. Reads the total itself unless `known` is given; draws nothing while it is
 *  unknown, in an edition without Spending, or, with `hideWhenNothing`, when nothing cost money
 *  and nothing went unpriced: a free AI's line would only say "$0". */
export function SpentLine({ query, sentence, name, to, known, hideWhenNothing, onRead }: {
  query: Query;
  sentence: "settings" | "ai" | "conversation" | "card";
  name?: string;
  /** #/spending?cut=…&key=…&per=… */
  to: string;
  /** What the caller holds already: null while it holds nothing, and then the line reads once. */
  known?: SpentTotal | null;
  hideWhenNothing: boolean;
  /** Told what the line read, for a caller that keeps it between two appearances. */
  onRead?: (spent: SpentTotal) => void;
}) {
  const { t, locale } = useI18n();
  const [read, setRead] = useState<SpentTotal | null>(null);
  const shown = spendingShown(data);
  // Once, as it first appears: after that, what it was given keeps it current.
  const asked = useRef(false);
  // What the caller gave last: a read that lands after it gave something is older than that.
  const given = useRef(known);
  useEffect(() => {
    given.current = known;
  });
  const { model, card, conversation, days } = query;
  useEffect(() => {
    if (!shown || known || asked.current) return;
    asked.current = true;
    data.spending!.total({ model, card, conversation, days }).then((spent) => {
      if (given.current) return;
      setRead(spent);
      onRead?.(spent);
    }, () => {
      // A line that leads somewhere is no place for a failure: it stays away.
    });
  }, [shown, known, model, card, conversation, days, onRead]);

  const spent = known ?? read;
  if (!spentLineShown(data, spent, hideWhenNothing) || !spent) return null;
  const money = moneyText({ cost: spent.total, unpriced: spent.unpriced_calls, currency: spent.currency }, "total", locale, t);
  const said = sentence === "settings"
    ? `${t("spending.title")} · ${t("spending.link.settings", { money })}`
    : sentence === "card"
      ? t("spending.link.card", { name: name ?? "", money })
      : t(`spending.link.${sentence}`, { money });
  return (
    // The router's own address, without the "#" a hash router writes before it.
    <Link
      to={to.replace(/^#/, "")}
      data-spent-line
      className="flex min-h-11 max-w-full items-center gap-1.5 text-sm text-mist hover:text-parchment"
    >
      {/* Goes to the next line, never cut: the amount is what the line is for. */}
      <span className="min-w-0 [overflow-wrap:anywhere]">{said}</span>
      <ChevronRight className="h-4 w-4 shrink-0" aria-hidden="true" />
    </Link>
  );
}

/** Whether the line is drawn: never in an edition without Spending, nor while the amount is
 *  unknown; and, with `hideWhenNothing`, not when nothing cost money and nothing went unpriced. */
export function spentLineShown(source: Pick<DataSource, "spending">, spent: SpentTotal | null, hideWhenNothing: boolean): boolean {
  if (!spendingShown(source) || !spent) return false;
  return !hideWhenNothing || spent.total > 0 || spent.unpriced_calls > 0;
}

/** What a window of deletion says is kept of what was spent; null in an edition without Spending. */
export function keptSaid(t: Translate, source: Pick<DataSource, "spending"> = data): string | null {
  return spendingShown(source) ? t("spending.kept") : null;
}

/** What a window of deletion says is kept of what was spent, and its tick to keep it under no
 *  name, unticked. The tick is read once the yes is given: the box is gone by then, so it is
 *  followed as it changes rather than read from the page. Null in an edition without Spending. */
export function keptOnDelete(
  t: Translate, source: Pick<DataSource, "spending"> = data,
): { details: React.ReactNode; forgetName: () => boolean } | null {
  const said = keptSaid(t, source);
  if (said === null) return null;
  let ticked = false;
  return {
    details: (
      <>
        <p>{said}</p>
        <label className="touch-target flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            defaultChecked={false}
            onChange={(e) => {
              ticked = e.target.checked;
            }}
            className="mt-0.5 h-4 w-4 shrink-0 accent-[#e29a3e]"
          />
          <span>{t("spending.forgetTick")}</span>
        </label>
      </>
    ),
    forgetName: () => ticked,
  };
}
