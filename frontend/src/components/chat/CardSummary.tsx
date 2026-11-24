import { CardTags } from "@/components/cards/CardTags";
import { Avatar } from "@/components/ui/Avatar";
import { Modal } from "@/components/ui/Modal";
import { Tag } from "@/components/ui/Tag";
import { speakingName } from "@/engine";
import { useI18n } from "@/i18n/I18nProvider";
import { plainPresentation } from "@/lib/cards/read";
import { chosenNotes, notesVersions } from "@/lib/presentation/notes";
import { cardText, firstCodePoints, previewMacros, smallPortrait } from "@/lib/utils";
import type { Character } from "@/types";
import { ArrowRight } from "lucide-react";
import { useMemo } from "react";
import { Link } from "react-router";

/** The card a conversation is played with, in short, opened from the conversation itself, with the way
 *  to the whole card. The card's page lists its conversations, which is the way back. */
export function CardSummary({
  character,
  personaName,
  onClose,
}: {
  character: Character;
  personaName: string | null;
  onClose: () => void;
}) {
  const { t, locale } = useI18n();
  const isScenario = character.kind === "scenario";
  const you = personaName ?? t("chat.panel.sceneAnchor.youFallback");
  const name = speakingName(character);
  const { tagline, creator_notes, creator_notes_multilingual, description, card_rules } = character;

  // On a phone the window must keep its button in reach: the tagline on three lines at most, and
  // only what they can show is laid out.
  const shownTagline = useMemo(() => firstCodePoints(previewMacros(tagline, name, you), 2_000), [tagline, name, you]);
  const versions = useMemo(
    () => notesVersions({ creator_notes, creator_notes_multilingual }),
    [creator_notes, creator_notes_multilingual],
  );
  const chosen = chosenNotes(versions, locale);
  const notes = chosen >= 0 ? versions[chosen].text : null;
  // The author's presentation in plain words, its markers read as names; else, for a card made
  // here, the description as the model reads it. Six lines never show more than 2 000 code points,
  // and line-clamp still has the browser break every line it hides. Read once: the summary draws
  // again without the card changing.
  const about = useMemo(
    () =>
      firstCodePoints(
        notes !== null ? previewMacros(plainPresentation(notes), name, you) : cardText(description, card_rules, name, you),
        2_000,
      ),
    [notes, description, card_rules, name, you],
  );

  return (
    <Modal title={character.name} onClose={onClose}>
      <div className="flex items-start gap-4">
        <Avatar name={character.name} src={smallPortrait(character)} className="h-20 w-20 shrink-0 text-3xl" />
        <div className="min-w-0">
          <Tag tone={isScenario ? "arcane" : "ember"}>
            {isScenario ? t("chat.panel.kindScenario") : t("chat.panel.kindCharacter")}
          </Tag>
          {shownTagline && (
            <p className="mt-2 line-clamp-3 italic text-parchment-dim [overflow-wrap:anywhere]">{shownTagline}</p>
          )}
        </div>
      </div>
      {about && (
        // The start of it: the card's page has the rest.
        <p className="mt-4 line-clamp-6 whitespace-pre-wrap break-words text-sm leading-relaxed text-parchment-dim">
          {about}
        </p>
      )}
      <CardTags tags={character.tags} />
      <div className="mt-5 flex justify-end">
        <Link to={`/characters/${character.id}`} className="btn btn-primary">
          {t("chat.cardSummary.openButton")} <ArrowRight className="h-4 w-4" />
        </Link>
      </div>
    </Modal>
  );
}
