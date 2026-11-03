import type { ConsolidateResult, ExtractResult } from "@/data/source";
import type { Translate } from "@/i18n/I18nProvider";

/** What a consolidation did, as a sentence. When it was skipped nothing was
 *  altered, and the person is told why: there were too few facts to merge, the
 *  facts changed while the model was merging them, or another memory task was
 *  running. */
export function describeConsolidation(result: ConsolidateResult, t: Translate): string {
  if (result.skipped === "too_few") return t("chat.panel.facts.tooFewToConsolidate");
  if (result.skipped === "changed") return t("chat.panel.facts.changedWhileConsolidating");
  if (result.skipped === "busy") return t("chat.panel.facts.memoryTaskRunning");
  return t("chat.panel.facts.consolidated", { before: result.before, after: result.after });
}

/** What "memorize now" did, as a sentence. Finding nothing new is not the same as not
 *  having looked, which is what happens while another memory task is running, or as
 *  having looked at turns that were removed meanwhile, of which nothing is kept. */
export function describeExtraction(result: ExtractResult, t: Translate): string {
  if (result.skipped === "busy") return t("chat.panel.facts.memoryTaskRunning");
  if (result.skipped === "changed") return t("chat.panel.facts.conversationChangedWhileReading");
  if (result.facts_added.length > 0) {
    return t("chat.panel.facts.addedCount", { count: result.facts_added.length });
  }
  return t("chat.panel.facts.noneNew");
}
