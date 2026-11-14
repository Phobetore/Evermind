import type { CardCharacter } from "@/data";
import { useT } from "@/i18n/useT";
import { describeError } from "@/lib/errors";
import { rereadOffer, type FoundCard, type ReportLine, type RereadMode } from "@/lib/cards";
import { History } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";

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
  // Weighed again at each keystroke in the form: what it lists needs no pairing of the entries,
  // which only the click and the export do.
  const plan = useMemo(() => (found === undefined ? null : rereadOffer(current, found)), [current, found]);
  // A pressed button leaves the page with what it changed: the line that takes its place takes
  // its focus, or the banner does, or a keyboard or a screen reader would be thrown back to the
  // top of the page. Only after a press: as the page loads, the focus stays where it is.
  const section = useRef<HTMLElement>(null);
  const pressed = useRef(false);
  // The banner holds the focus it took until the person moves it: a line it gave it to, such as
  // "Loading…", may go in turn.
  const holding = useRef(false);
  useEffect(() => {
    const active = document.activeElement;
    // The button is still there, the answer to come: wait for the render that removes it.
    if (active && section.current?.contains(active)) return;
    if (!pressed.current && !holding.current) return;
    pressed.current = false;
    // Moved elsewhere by the person: left there.
    holding.current = !active || active === document.body;
    if (holding.current) (section.current?.querySelector<HTMLElement>("[data-takes-focus]") ?? section.current)?.focus();
  });
  const press = (act: () => void) => () => {
    pressed.current = true;
    act();
  };

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
    <section ref={section} tabIndex={-1} className="flex flex-col break-words outline-none gap-3 [&>*]:min-w-0 rounded-xl border border-arcane-500/40 bg-arcane-glow/40 p-4 text-sm leading-relaxed text-mist">
      <p className="flex items-center gap-2 font-display font-semibold text-arcane-300">
        <History className="h-4 w-4 shrink-0" /> <span className="min-w-0 break-words">{t("characters.reread.title")}</span>
      </p>
      {failure ? (
        <div className="flex flex-col items-start gap-2">
          <p role="alert" className="break-words text-blood">{describeError(failure.error, t)}</p>
          <button type="button" className="btn btn-ghost !py-2 text-sm min-w-0 !whitespace-normal wrap-anywhere" onClick={press(onRetry)}>
            {t("characters.reread.retry")}
          </button>
        </div>
      ) : !plan ? (
        <p data-takes-focus tabIndex={-1} className="animate-pulse-soft outline-none">{t("common.loading")}</p>
      ) : applied ? (
        <p data-takes-focus tabIndex={-1} role="status" className="font-semibold text-parchment outline-none">
          {t("characters.reread.saveToKeep")}
        </p>
      ) : (
        <>
          {plan.added.length > 0 && (
            <div>
              <p className="font-semibold text-parchment-dim">{t("characters.reread.added")}</p>
              <ul className="mt-1 list-disc break-words pl-4 marker:text-arcane-500/70">
                {plan.added.flatMap(said).map((item) => <li key={item}>{item}</li>)}
              </ul>
            </div>
          )}
          {plan.untouched.length > 0 && (
            <div>
              <p className="font-semibold text-parchment-dim">{t("characters.reread.untouched")}</p>
              <ul className="mt-1 list-disc break-words pl-4 marker:text-arcane-500/70">
                {plan.untouched.map((field) => <li key={field}>{label(field)}</li>)}
              </ul>
            </div>
          )}
          <div>
            <p className="font-semibold text-parchment-dim">{t("characters.reread.changes")}</p>
            <ul className="mt-1 list-disc break-words pl-4 marker:text-arcane-500/70">
              {CHANGES.map((change) => <li key={change}>{t(`characters.reread.change.${change}`)}</li>)}
            </ul>
          </div>
          {/* The labels are whole sentences: on a phone they wrap, each button the width of the banner. */}
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            {found ? (
              <>
                <button type="button" className="btn btn-primary !py-2 text-sm min-w-0 !whitespace-normal wrap-anywhere text-center" onClick={press(() => onApply("reread"))}>
                  {t("characters.reread.reread")}
                </button>
                {/* Once kept, the card is there: only the new rules are left to offer. */}
                {!hasCard && (
                  <button type="button" className="btn btn-ghost !py-2 text-sm min-w-0 !whitespace-normal wrap-anywhere text-center" onClick={press(() => onApply("keep"))}>
                    {t("characters.reread.keep")}
                  </button>
                )}
              </>
            ) : (
              <button type="button" className="btn btn-primary !py-2 text-sm min-w-0 !whitespace-normal wrap-anywhere text-center" onClick={press(() => onApply("reread"))}>
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
