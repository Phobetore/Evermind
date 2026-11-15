import { RpText } from "@/components/chat/RpText";
import { Folded } from "@/components/ui/Folded";
import { speakingName } from "@/engine";
import { useT } from "@/i18n/useT";
import { layoutRefusal } from "@/lib/presentation/bounds";
import { cardText } from "@/lib/utils";
import type { Character } from "@/types";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";

/** The card's openings, each whole, as the conversation will get it: through cardText, and laid out
 *  as a message is. Those its text leaves blank are left out, as the server leaves them out of a
 *  new conversation. Nothing without one. */
export function CharacterGreetings({ character, you }: { character: Character; you: string }) {
  const t = useT();
  const { greeting, alternate_greetings, card_rules } = character;
  const name = speakingName(character);
  // Computed once per card: the names are measured over each whole text.
  const greetings = useMemo(
    () =>
      [greeting, ...alternate_greetings]
        .map((text) => cardText(text, card_rules, name, you))
        .filter((text) => text.trim() !== ""),
    [greeting, alternate_greetings, card_rules, name, you],
  );
  const [index, setIndex] = useState(0);
  const count = greetings.length;
  const at = Math.min(index, count - 1);
  const shown = count > 0 ? greetings[at] : "";
  // The text shown is what is measured: names can lengthen it past the bound, and a comment the
  // card rules take out can shorten it under.
  const refusal = useMemo(() => layoutRefusal(shown), [shown]);
  if (count === 0) return null;

  return (
    <section className="mt-7">
      <h2 className="ui-label mb-2">{t("characters.detail.openingHeading")}</h2>
      {count > 1 && (
        <div className="mb-2 flex items-center gap-2">
          <button
            type="button"
            className="btn btn-ghost min-h-11 min-w-11 px-2"
            aria-label={t("characters.detail.previousGreeting")}
            onClick={() => setIndex((at - 1 + count) % count)}
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="text-sm text-mist">{t("characters.detail.greetingOf", { index: at + 1, count })}</span>
          <button
            type="button"
            className="btn btn-ghost min-h-11 min-w-11 px-2"
            aria-label={t("characters.detail.nextGreeting")}
            onClick={() => setIndex((at + 1) % count)}
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      )}
      {/* Above the fold, which would hide it. */}
      {refusal && <p className="mb-3 text-sm text-mist">{t(`characters.presentation.${refusal}`)}</p>}
      <Folded>
        <div className="rounded-xl border border-ink-700 bg-ink-900/70 p-4 text-parchment-dim">
          <RpText text={shown} />
        </div>
      </Folded>
    </section>
  );
}
