import type { CharacterTile } from "@/types";
import { clsx } from "clsx";
import { BookOpenText, MessageCircle, Star } from "lucide-react";
import { useId, useMemo } from "react";
import { Link, useNavigate } from "react-router";
import { otherTags, SHOWN_FIRST } from "@/components/cards/CardTags";
import { Avatar } from "@/components/ui/Avatar";
import { Tag, TagText } from "@/components/ui/Tag";
import { speakingName } from "@/engine";
import { useT } from "@/i18n/useT";
import { wantSizes } from "@/lib/portraitSizes";
import { firstCodePoints, previewMacros } from "@/lib/utils";

// From sm up the tile keeps the three tags it always showed.
const SHOWN_WIDE = 3;

export function CharacterCard({
  character,
  onToggleFavorite,
  error,
}: {
  character: CharacterTile;
  onToggleFavorite?: (character: CharacterTile) => void;
  /** Why the star did not go through. */
  error?: string;
}) {
  const navigate = useNavigate();
  const t = useT();
  const isScenario = character.kind === "scenario";
  const titleId = useId();
  const textId = useId();
  const tagsId = useId();
  // The home page draws again at every letter typed in the search, and the API does not bound a
  // tagline: it is cut once, not at each draw. A card with no tagline says what it is about with
  // the first real sentence of its description, which the server has found.
  const youFallback = t("chat.panel.sceneAnchor.youFallback");
  const speaker = speakingName(character);
  const source = character.tagline.trim() ? character.tagline : character.excerpt;
  const text = useMemo(
    () => firstCodePoints(previewMacros(source, speaker, youFallback), 2_000),
    [source, speaker, youFallback],
  );
  const tags = character.tags.slice(0, SHOWN_FIRST);
  const others = otherTags(character.tags);
  const described = [text && textId, tags.length > 0 && tagsId].filter(Boolean).join(" ");

  return (
    <Link
      to={`/characters/${character.id}`}
      // Named by its title alone: the picture is left unnamed, or a screen reader would say the name twice.
      aria-labelledby={titleId}
      aria-describedby={described || undefined}
      className="card-tile group relative flex aspect-[2/3] flex-col justify-end overflow-hidden rounded-2xl border border-ink-700 bg-ink-850 shadow-card transition-all duration-300 hover:-translate-y-1.5 hover:border-ember-600/50 hover:shadow-lift sm:aspect-[3/4]"
    >
      <div className="absolute inset-0">
        {/* On a phone the copy made for the grid; from sm up the whole picture, which the copy of
            480 pixels would be drawn larger than. A card with no copy yet asks for them once its
            picture is shown, on any screen: a computer makes the ones a phone will use. */}
        <Avatar
          name={character.name}
          src={character.avatar_thumb_url ?? character.avatar_url}
          wideSrc={character.avatar_thumb_url ? (character.avatar_url ?? undefined) : undefined}
          alt=""
          loading="lazy"
          decoding="async"
          onLoad={character.avatar_thumb_url ? undefined : () => wantSizes(character)}
          rounded="rounded-none"
          className="h-full w-full text-7xl transition-transform duration-500 group-hover:scale-[1.04]"
        />
        <div className="card-shade absolute inset-0 bg-gradient-to-t from-ink-950 via-ink-950/45 to-transparent" />
      </div>

      {onToggleFavorite && (
        <button
          onClick={(e) => {
            e.preventDefault();
            onToggleFavorite(character);
          }}
          title={character.is_favorite ? t("characters.removeFavoriteTitle") : t("characters.addFavoriteTitle")}
          className={clsx(
            // Blurred from sm up only: on a phone, 300 cards would make 600 blurred layers, over
            // backgrounds nearly opaque all the same.
            "absolute right-3 top-3 z-10 rounded-full border p-2 transition-all sm:backdrop-blur md:p-1.5",
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
          className="!bg-ink-950/85 sm:backdrop-blur-sm"
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

      {/* The text is cut at two lines, three with no tags below it; on a phone the tags slide in one
          row (.card-tags in styles.css), and a touch on them opens the card like anywhere else on it. */}
      <div className="card-caption relative z-10 flex flex-col gap-1.5 p-3 sm:p-4">
        <h2
          id={titleId}
          className="font-display text-base font-semibold leading-tight text-parchment drop-shadow [overflow-wrap:anywhere] max-sm:line-clamp-2 sm:text-xl"
        >
          {character.name}
        </h2>
        {text && (
          // line-clamp sets its display with its cut: a display after it would undo the cut.
          <p
            id={textId}
            className={clsx(
              "card-text text-[0.8rem] italic leading-snug text-parchment-dim [overflow-wrap:anywhere] sm:line-clamp-2 sm:text-sm",
              tags.length > 0 ? "line-clamp-2" : "line-clamp-3",
            )}
          >
            {text}
          </p>
        )}
        {tags.length > 0 && (
          <>
            {/* Out of the keyboard's way: Chrome makes every box that scrolls a stop, 300 more. */}
            <div className="card-tags mt-1 flex sm:flex-wrap sm:gap-1.5" tabIndex={-1}>
              {tags.map((tag, i) => (
                // A card may carry the same tag twice.
                <Tag key={i} className={clsx("max-w-full shrink-0", i >= SHOWN_WIDE && "sm:hidden")}>
                  <TagText tag={tag} />
                </Tag>
              ))}
              {/* Not CardTags' button: the tile is a link, and a touch on it opens the card. */}
              {others > 0 && (
                <Tag className="shrink-0 sm:hidden">{t("characters.detail.moreTags", { count: others })}</Tag>
              )}
            </div>
            <span id={tagsId} className="sr-only">
              {t("home.card.tags", { list: tags.map((tag) => firstCodePoints(tag, 2_000)).join(", ") })}
            </span>
          </>
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
