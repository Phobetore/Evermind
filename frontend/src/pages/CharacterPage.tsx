import { CardTags } from "@/components/cards/CardTags";
import { CharacterGreetings } from "@/components/cards/CharacterGreetings";
import { CharacterNotes } from "@/components/cards/CharacterNotes";
import { StartChatModal } from "@/components/cards/StartChatModal";
import { SpentLine } from "@/components/spending/SpentLine";
import { WhatTheModelReads } from "@/components/cards/WhatTheModelReads";
import { Avatar } from "@/components/ui/Avatar";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { PageWait } from "@/components/ui/PageWait";
import { Tag } from "@/components/ui/Tag";
import { data } from "@/data";
import { speakingName } from "@/engine";
import { useT } from "@/i18n/useT";
import { describeError } from "@/lib/errors";
import { firstCodePoints, mediumPortrait, previewMacros, timeAgo } from "@/lib/utils";
import type { Character, CharacterWithLore, Conversation } from "@/types";
import { MessageCircle, Pencil, Star } from "lucide-react";
import { clsx } from "clsx";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";

function CharacterDetail({ id }: { id: string }) {
  const navigate = useNavigate();
  const [search] = useSearchParams();
  const t = useT();
  // Replaced whole by the answer to each write, which carries only a Character's fields. What only
  // the read of the card gives (its lorebook here) is kept in a state of its own, set where the
  // page reads the card, and never read from this one.
  const [character, setCharacter] = useState<Character | null>(null);
  // The active entries of the lorebook: one switched off, the model never reads.
  const [lore, setLore] = useState(0);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [showStart, setShowStart] = useState(false);
  // The error, not its sentence: described when drawn, it follows a change of language.
  const [failure, setFailure] = useState<{ error: unknown } | null>(null);
  const [conversationsFailure, setConversationsFailure] = useState<{ error: unknown } | null>(null);
  const [favoriteFailure, setFavoriteFailure] = useState<{ error: unknown } | null>(null);
  // The name the server gives the player in a new conversation, and in every prompt of it: the
  // persona marked as the default, else "User" (backend/app/prompting, the same fallback), never
  // a word of the interface. Until the list arrives, or if it cannot, the server's fallback.
  const [player, setPlayer] = useState("User");

  useEffect(() => {
    let live = true;
    data.personas.list().then(
      (personas) => live && setPlayer(personas.find((persona) => persona.is_default)?.name || "User"),
      () => {},
    );
    return () => {
      live = false;
    };
  }, []);

  const readConversations = useCallback(() => {
    data.conversations.list({ character_id: id }).then((list) => {
      setConversations(list);
      setConversationsFailure(null);
    }, (error) => setConversationsFailure({ error }));
  }, [id]);

  const received = useCallback((c: CharacterWithLore) => {
    setCharacter(c);
    setLore(c.lore_entries.filter((entry) => entry.enabled).length);
  }, []);

  useEffect(() => {
    data.characters
      .get(id)
      .then((c) => {
        received(c);
        if (search.get("start")) setShowStart(true);
      })
      .catch((error) => setFailure({ error }));
    readConversations();
  }, [id, search, readConversations, received]);

  // For what the author shows the person (the tagline, the presentation): the person reading.
  const you = t("chat.panel.sceneAnchor.youFallback");
  const name = character ? speakingName(character) : "";
  const rawTagline = character?.tagline ?? "";
  // From the card, without a bound of length: read once, and only what three lines can show is
  // laid out. The page draws again when the start window opens or the list arrives.
  const tagline = useMemo(() => firstCodePoints(previewMacros(rawTagline, name, you), 2_000), [rawTagline, name, you]);

  if (failure) return <p className="p-10 text-blood">{describeError(failure.error, t)}</p>;
  if (!character) return <PageWait words={t("common.loading")} />;

  const isScenario = character.kind === "scenario";

  const toggleFavorite = async () => {
    setFavoriteFailure(null);
    try {
      setCharacter(await data.characters.update(character.id, { is_favorite: !character.is_favorite }));
    } catch (error) {
      setFavoriteFailure({ error });
      // It may have gone through all the same: the button shows what the server holds.
      data.characters.get(character.id).then(received, () => {});
    }
  };

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <div className="flex flex-col gap-8 lg:flex-row animate-rise">
        <div className="shrink-0">
          <div className="relative mx-auto w-56 overflow-hidden rounded-2xl border border-ink-700 shadow-card lg:mx-0">
            <Avatar
              name={character.name}
              src={mediumPortrait(character)}
              rounded="rounded-none"
              className="aspect-[3/4] w-full text-7xl"
            />
          </div>
        </div>

        <div className="min-w-0 flex-1">
          <Tag tone={isScenario ? "arcane" : "ember"}>
            {isScenario ? t("chat.panel.kindScenario") : t("chat.panel.kindCharacter")}
          </Tag>
          {/* Clipped: combining marks stacked on one letter of the name would paint over the
              portrait and the page above it. */}
          <h1 className="mt-2 overflow-clip break-words font-display text-4xl font-semibold tracking-tight">
            {character.name}
          </h1>
          {/* From the card, without a bound of length: two lines at most, and only what they can
              show is laid out. */}
          {character.creator && (
            <p className="mt-1 line-clamp-2 text-sm text-mist [overflow-wrap:anywhere]">
              {t("characters.detail.byCreator", { creator: firstCodePoints(character.creator, 2_000) })}
            </p>
          )}
          {character.character_version && (
            <p className="mt-0.5 line-clamp-2 text-sm text-mist [overflow-wrap:anywhere]">
              {t("characters.detail.version", { version: firstCodePoints(character.character_version, 2_000) })}
            </p>
          )}
          {tagline && (
            <p className="mt-1.5 line-clamp-3 text-lg italic text-parchment-dim [overflow-wrap:anywhere]">{tagline}</p>
          )}
          <CardTags tags={character.tags} />

          <div className="mt-5 flex flex-wrap gap-2">
            <button className="btn btn-primary" onClick={() => setShowStart(true)}>
              <MessageCircle className="h-4 w-4" /> {t("characters.detail.startConversationButton")}
            </button>
            <Link to={`/characters/${character.id}/edit`} className="btn btn-ghost">
              <Pencil className="h-4 w-4" /> {t("characters.detail.editButton")}
            </Link>
            <button
              className={clsx(
                "btn",
                character.is_favorite
                  ? "border border-ember-500/60 bg-ember-glow text-ember-300"
                  : "btn-ghost",
              )}
              onClick={toggleFavorite}
            >
              <Star className={clsx("h-4 w-4", character.is_favorite && "fill-current")} />
              {character.is_favorite ? t("characters.favoritedLabel") : t("characters.addFavoriteTitle")}
            </button>
          </div>
          {character.card_rules === 1 && (
            <Link to={`/characters/${character.id}/edit`} className="mt-3 inline-block text-xs text-mist-dim underline-offset-2 hover:text-parchment hover:underline">
              {t("characters.detail.rereadable")}
            </Link>
          )}
          {favoriteFailure && (
            <p role="alert" className="mt-3 rounded-lg border border-blood/40 bg-blood/10 px-4 py-2.5 text-sm text-blood">
              {describeError(favoriteFailure.error, t)}
            </p>
          )}

          <CharacterNotes character={character} you={you} />
          {/* As the conversation will get them, and as the model reads them: the player's name. */}
          <CharacterGreetings character={character} you={player} />
          <WhatTheModelReads character={character} lore={lore} you={player} />

          {(conversationsFailure || conversations.length > 0) && (
            <section className="mt-8">
              <h2 className="ui-label mb-3">{t("characters.detail.yourConversationsHeading")}</h2>
              {conversationsFailure ? (
                <LoadFailure error={conversationsFailure.error} onRetry={readConversations} />
              ) : (
                <div className="flex flex-col gap-2">
                  {conversations.map((c) => (
                    <button
                      key={c.id}
                      onClick={() => navigate(`/chat/${c.id}`)}
                      className="panel flex items-center justify-between gap-4 px-4 py-3 text-left transition-colors hover:border-ember-600/40"
                    >
                      <span className="truncate font-display text-sm font-medium">
                        {c.title || t("chatList.untitled")}
                      </span>
                      <span className="shrink-0 text-xs text-mist-dim">
                        {t("chatList.messageCount", { count: c.message_count ?? 0 })} · {timeAgo(c.last_message_at ?? c.updated_at, t)}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </section>
          )}
          {/* What playing with it has cost, its conversations deleted since included. */}
          <div className="mt-3">
            <SpentLine
              query={{ card: character.id, days: "all" }}
              sentence="card"
              name={character.name}
              to={`#/spending?cut=card&key=${encodeURIComponent(character.id)}&per=all`}
              hideWhenNothing
            />
          </div>
        </div>
      </div>

      {showStart && (
        <StartChatModal character={character} onClose={() => setShowStart(false)} />
      )}
    </div>
  );
}

/** Keyed by the id, so that going from one card to another starts afresh
 *  instead of showing the previous card until the next one arrives. */
export function CharacterPage() {
  const { id = "" } = useParams();
  return <CharacterDetail key={id} id={id} />;
}
