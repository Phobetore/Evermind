import { Avatar } from "@/components/ui/Avatar";
import { Modal } from "@/components/ui/Modal";
import { Tag } from "@/components/ui/Tag";
import { useT } from "@/i18n/useT";
import { previewMacros } from "@/lib/utils";
import type { Character } from "@/types";
import { BookOpen } from "lucide-react";
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
  const t = useT();
  const isScenario = character.kind === "scenario";
  const you = personaName ?? t("chat.panel.sceneAnchor.youFallback");
  return (
    <Modal title={character.name} onClose={onClose}>
      <div className="flex items-start gap-4">
        <Avatar name={character.name} src={character.avatar_url} className="h-20 w-20 shrink-0 text-3xl" />
        <div className="min-w-0">
          <Tag tone={isScenario ? "arcane" : "ember"}>
            {isScenario ? t("chat.panel.kindScenario") : t("chat.panel.kindCharacter")}
          </Tag>
          {character.tagline && (
            <p className="mt-2 break-words italic text-parchment-dim">
              {previewMacros(character.tagline, character.name, you)}
            </p>
          )}
        </div>
      </div>
      {character.description && (
        // The start of it: the card's page has the rest.
        <p className="mt-4 line-clamp-6 whitespace-pre-wrap break-words text-sm leading-relaxed text-parchment-dim">
          {previewMacros(character.description, character.name, you)}
        </p>
      )}
      {character.tags.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {character.tags.map((tag) => (
            <Tag key={tag}>{tag}</Tag>
          ))}
        </div>
      )}
      <div className="mt-5 flex justify-end">
        <Link to={`/characters/${character.id}`} className="btn btn-primary">
          <BookOpen className="h-4 w-4" /> {t("chat.cardSummary.openButton")}
        </Link>
      </div>
    </Modal>
  );
}
