import type { ConsolidateResult, ExtractResult } from "@/data/source";
import type { Translate } from "@/i18n/I18nProvider";

/** What a consolidation did, as a sentence. */
export function describeConsolidation(result: ConsolidateResult, t: Translate): string {
  return t("chat.panel.facts.consolidated", { before: result.before, after: result.after });
}

/** What "memorize now" did, as a sentence. With no new fact, a summary that is not the
 *  one shown before is still news. */
export function describeExtraction(
  result: ExtractResult,
  t: Translate,
  summaryBefore: string,
): string {
  if (result.facts_added.length > 0) {
    return t("chat.panel.facts.addedCount", { count: result.facts_added.length });
  }
  if (result.summary && result.summary !== summaryBefore) return t("chat.panel.facts.summaryOnly");
  return t("chat.panel.facts.noneNew");
}
