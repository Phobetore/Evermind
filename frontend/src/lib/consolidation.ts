import type { ConsolidateResult } from "@/data/source";
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
