import { data, type DataSource } from "@/data";
import { useI18n } from "@/i18n/I18nProvider";
import { moneyText, spendingShown } from "@/lib/spending";
import { isolated } from "@/lib/utils";
import type { SpentTotal } from "@/types";
import { ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";

type Query = { model?: string; card?: string; conversation?: string; days: 30 | "all" };

/** What one AI, one character, one conversation, or everything has cost, as a line that opens
 *  Spending on it. Reads the total as it appears, and again each time `reread` changes; between
 *  two reads, each `known` it is given is what it shows. Draws nothing while it is unknown, in an
 *  edition without Spending, or, with `hideWhenNothing`, when nothing cost money and nothing went
 *  unpriced: a free AI's line would only say "$0". */
export function SpentLine({ query, sentence, name, to, known, reread = 0, hideWhenNothing }: {
  query: Query;
  sentence: "settings" | "ai" | "conversation" | "card";
  name?: string;
  /** #/spending?cut=…&key=…&per=… */
  to: string;
  /** What the caller learns as it goes, such as the end of each turn: what it holds as the line
   *  appears is not taken, the line reads its own. */
  known?: SpentTotal | null;
  /** Changes when what the line holds may have moved without the caller knowing by how much. */
  reread?: number;
  hideWhenNothing: boolean;
}) {
  const { t, locale } = useI18n();
  const shown = spendingShown(data);
  // What the caller held as the line appeared is not taken: the line reads its own.
  const [initial] = useState(known);
  const given = known !== initial ? (known ?? null) : null;
  // Each read lands with what had been given when it was sent: one sent before the last amount
  // given is older than it.
  const [read, setRead] = useState<{ spent: SpentTotal; under: SpentTotal | null } | null>(null);
  const givenNow = useRef(given);
  useEffect(() => {
    givenNow.current = given;
  });
  const { model, card, conversation, days } = query;
  useEffect(() => {
    if (!shown) return;
    const under = givenNow.current;
    let gone = false;
    data.spending!.total({ model, card, conversation, days }).then((spent) => {
      if (!gone) setRead({ spent, under });
    }, () => {
      // A line that leads somewhere is no place for a failure: it stays away.
    });
    return () => {
      gone = true;
    };
  }, [shown, model, card, conversation, days, reread]);
  const spent = read && read.under === given ? read.spent : (given ?? read?.spent ?? null);

  if (!spentLineShown(data, spent, hideWhenNothing) || !spent) return null;
  const money = moneyText({ cost: spent.total, unpriced: spent.unpriced_calls, currency: spent.currency }, "total", locale, t);
  const said = sentence === "settings"
    ? `${t("spending.title")} · ${t("spending.link.settings", { money })}`
    : sentence === "card"
      ? t("spending.link.card", { name: isolated(name ?? ""), money })
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
