import type { Character } from "@/types";
import { clsx } from "clsx";
import { BookOpenText, MessageCircle, Star } from "lucide-react";
import { Link, useNavigate } from "react-router";
import { Avatar } from "@/components/ui/Avatar";
import { Tag } from "@/components/ui/Tag";
import { useT } from "@/i18n/useT";

export function CharacterCard({
  character,
  onToggleFavorite,
  error,
}: {
  character: Character;
  onToggleFavorite?: (character: Character) => void;
  /** Why the star did not go through. */
  error?: string;
}) {
  const navigate = useNavigate();
  const t = useT();
  const isScenario = character.kind === "scenario";

  return (
    <Link
      to={`/characters/${character.id}`}
      className="group relative flex aspect-[3/4] flex-col justify-end overflow-hidden rounded-2xl border border-ink-700 bg-ink-850 shadow-card transition-all duration-300 hover:-translate-y-1.5 hover:border-ember-600/50 hover:shadow-lift"
    >
      <div className="absolute inset-0">
        <Avatar
          name={character.name}
          src={character.avatar_url}
          rounded="rounded-none"
          className="h-full w-full text-7xl transition-transform duration-500 group-hover:scale-[1.04]"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-ink-950 via-ink-950/45 to-transparent" />
      </div>

      {onToggleFavorite && (
        <button
          onClick={(e) => {
            e.preventDefault();
            onToggleFavorite(character);
          }}
          title={character.is_favorite ? t("characters.removeFavoriteTitle") : t("characters.addFavoriteTitle")}
          className={clsx(
            "absolute right-3 top-3 z-10 rounded-full border p-2 backdrop-blur transition-all md:p-1.5",
            // 34px of button, 46px of reachable area, same drawing.
            "before:absolute before:-inset-1.5 before:content-[''] md:before:content-none",
            character.is_favorite
              ? "border-ember-500/60 bg-ink-950/60 text-ember-400"
              : "hover-actions border-ink-600/60 bg-ink-950/70 text-parchment-dim hover:text-ember-300",
          )}
        >
          <Star className={clsx("h-4 w-4", character.is_favorite && "fill-current")} />
        </button>
      )}
      {/* Over the caption: at 320px a long name comes up behind it. */}
      {error && (
        <p
          role="alert"
          className="absolute inset-x-2 top-14 z-20 rounded-lg border border-blood/40 bg-ink-950/90 px-2.5 py-1.5 text-xs leading-snug text-blood"
        >
          {error}
        </p>
      )}

      {/* Opaque: the tone glows are translucent, and on light artwork the label would not read. */}
      <div className="absolute left-3 top-3">
        <Tag
          tone={isScenario ? "arcane" : "ember"}
          className="!bg-ink-950/85 backdrop-blur-sm"
        >
          {isScenario ? (
            <span className="inline-flex items-center gap-1">
              <BookOpenText className="h-3 w-3" /> {t("chat.panel.kindScenario")}
            </span>
          ) : (
            t("chat.panel.kindCharacter")
          )}
        </Tag>
      </div>

      {/* Below sm the caption is the name alone: on a card about 154 by 205px, the whole caption would
          push the name out of it. */}
      <div className="relative z-10 flex flex-col gap-1.5 p-3 sm:p-4">
        <h2 className="font-display text-base font-semibold leading-tight text-parchment drop-shadow sm:text-xl">
          {character.name}
        </h2>
        {character.tagline && (
          <p className="line-clamp-2 hidden text-sm italic leading-snug text-parchment-dim sm:block">
            {character.tagline}
          </p>
        )}
        {character.tags.length > 0 && (
          <div className="mt-1 hidden flex-wrap gap-1.5 sm:flex">
            {character.tags.slice(0, 3).map((tag) => (
              <Tag key={tag}>{tag}</Tag>
            ))}
          </div>
        )}
        <button
          onClick={(e) => {
            e.preventDefault();
            navigate(`/characters/${character.id}?start=1`);
          }}
          className="btn btn-primary mt-2 hidden w-full translate-y-1 opacity-0 transition-all duration-300 group-hover:translate-y-0 group-hover:opacity-100 focus-visible:translate-y-0 focus-visible:opacity-100 [@media(hover:none)]:translate-y-0 [@media(hover:none)]:opacity-100 sm:inline-flex"
        >
          <MessageCircle className="h-4 w-4" />
          {t("characters.card.startButton")}
        </button>
      </div>
    </Link>
  );
}
