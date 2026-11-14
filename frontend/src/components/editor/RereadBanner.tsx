import type { CardCharacter } from "@/data";
import { useT } from "@/i18n/useT";
import { describeError } from "@/lib/errors";
import { rereadPlan, type FoundCard, type ReportLine, type RereadMode } from "@/lib/cards";
import { History } from "lucide-react";
import { useMemo } from "react";

/** What changes in the conversations of a card that moves to the new rules, whatever its card holds. */
const CHANGES = ["budget", "order", "wholeWords", "recursion", "examples", "instructions", "macros", "depth"] as const;

/** The offer to re-read a card made before cards were kept whole: what it would add, what it would
 *  leave as its owner left it, and what changes in its conversations. A click fills the form and
 *  saves nothing. */
export function RereadBanner({
  current,
  found,
  failure,
  hasCard,
  applied,
  label,
  onApply,
  onRetry,
}: {
  /** The form as it is now: what a re-reading is weighed against. */
  current: CardCharacter;
  /** The card found again; null when there is none, undefined while it is looked for. */
  found: FoundCard | null | undefined;
  /** Why the card could not be looked for. */
  failure: { error: unknown } | null;
  hasCard: boolean;
  /** A choice is in the form already, waiting for the save. */
  applied: boolean;
  /** The name the form gives a field of the card. */
  label: (field: string) => string;
  onApply: (mode: RereadMode) => void;
  /** Looks for the card again, after a failure. */
  onRetry: () => void;
}) {
  const t = useT();
  const plan = useMemo(() => (found === undefined ? null : rereadPlan(current, found, "reread")), [current, found]);

  const said = (line: ReportLine): string[] => {
    switch (line.key) {
      case "fields": return (line.names ?? []).map(label);
      case "lore": return [t("characters.reread.lore", { count: line.count ?? 0 })];
      case "nickname": return [t("characters.form.nicknameLabel")];
      case "characterNote": return [t("characters.form.noteLabel")];
      case "multilingualNotes": return [t("characters.form.multilingualLabel")];
      default: return [];
    }
  };

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-arcane-500/40 bg-arcane-glow/40 p-4 text-sm leading-relaxed text-mist">
      <p className="flex items-center gap-2 font-display font-semibold text-arcane-300">
        <History className="h-4 w-4 shrink-0" /> {t("characters.reread.title")}
      </p>
      {failure ? (
        <div className="flex flex-col items-start gap-2">
          <p role="alert" className="break-words text-blood">{describeError(failure.error, t)}</p>
          <button type="button" className="btn btn-ghost !py-2 text-sm" onClick={onRetry}>
            {t("characters.reread.retry")}
          </button>
        </div>
      ) : !plan ? (
        <p className="animate-pulse-soft">{t("common.loading")}</p>
      ) : applied ? (
        <p role="status" className="font-semibold text-parchment">{t("characters.reread.saveToKeep")}</p>
      ) : (
        <>
          {plan.added.length > 0 && (
            <div>
              <p className="font-semibold text-parchment-dim">{t("characters.reread.added")}</p>
              <ul className="mt-1 list-disc pl-4 marker:text-arcane-500/70">
                {plan.added.flatMap(said).map((item) => <li key={item}>{item}</li>)}
              </ul>
            </div>
          )}
          {plan.untouched.length > 0 && (
            <div>
              <p className="font-semibold text-parchment-dim">{t("characters.reread.untouched")}</p>
              <ul className="mt-1 list-disc pl-4 marker:text-arcane-500/70">
                {plan.untouched.map((field) => <li key={field}>{label(field)}</li>)}
              </ul>
            </div>
          )}
          <div>
            <p className="font-semibold text-parchment-dim">{t("characters.reread.changes")}</p>
            <ul className="mt-1 list-disc pl-4 marker:text-arcane-500/70">
              {CHANGES.map((change) => <li key={change}>{t(`characters.reread.change.${change}`)}</li>)}
            </ul>
          </div>
          <div className="flex flex-wrap gap-2">
            {found ? (
              <>
                <button type="button" className="btn btn-primary !py-2 text-sm" onClick={() => onApply("reread")}>
                  {t("characters.reread.reread")}
                </button>
                {/* Once kept, the card is there: only the new rules are left to offer. */}
                {!hasCard && (
                  <button type="button" className="btn btn-ghost !py-2 text-sm" onClick={() => onApply("keep")}>
                    {t("characters.reread.keep")}
                  </button>
                )}
              </>
            ) : (
              <button type="button" className="btn btn-primary !py-2 text-sm" onClick={() => onApply("reread")}>
                {t("characters.reread.switch")}
              </button>
            )}
          </div>
          {found && !hasCard && <p className="text-xs text-mist-dim">{t("characters.reread.keepHint")}</p>}
        </>
      )}
    </section>
  );
}
