"use client";

import { StartChatModal } from "@/components/cards/StartChatModal";
import { Avatar } from "@/components/ui/Avatar";
import { Tag } from "@/components/ui/Tag";
import { useT } from "@/i18n/useT";
import { api } from "@/lib/api";
import { previewMacros, timeAgo } from "@/lib/utils";
import type { Character, Conversation } from "@/types";
import { MessageCircle, Pencil, Star } from "lucide-react";
import { clsx } from "clsx";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, use, useEffect, useState } from "react";

function CharacterDetail({ id }: { id: string }) {
  const router = useRouter();
  const search = useSearchParams();
  const t = useT();
  const [character, setCharacter] = useState<Character | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [showStart, setShowStart] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<Character>(`/api/characters/${id}`)
      .then((c) => {
        setCharacter(c);
        if (search.get("start")) setShowStart(true);
      })
      .catch((e) => setError(e.message));
    api.get<Conversation[]>(`/api/conversations?character_id=${id}`).then(setConversations);
  }, [id, search]);

  if (error) return <p className="p-10 text-blood">{error}</p>;
  if (!character) return <div className="p-10 text-mist animate-pulse-soft">{t("common.loading")}</div>;

  const isScenario = character.kind === "scenario";

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <div className="flex flex-col gap-8 lg:flex-row animate-rise">
        {/* Portrait */}
        <div className="shrink-0">
          <div className="relative mx-auto w-56 overflow-hidden rounded-2xl border border-ink-700 shadow-card lg:mx-0">
            <Avatar
              name={character.name}
              src={character.avatar_url}
              rounded="rounded-none"
              className="aspect-[3/4] w-full text-7xl"
            />
          </div>
        </div>

        {/* Identity */}
        <div className="min-w-0 flex-1">
          <Tag tone={isScenario ? "arcane" : "ember"}>
            {isScenario ? t("chat.panel.kindScenario") : t("chat.panel.kindCharacter")}
          </Tag>
          <h1 className="mt-2 font-display text-4xl font-semibold tracking-tight">
            {character.name}
          </h1>
          {character.tagline && (
            <p className="mt-1.5 text-lg italic text-parchment-dim">{character.tagline}</p>
          )}
          {character.tags.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {character.tags.map((tag) => (
                <Tag key={tag}>{tag}</Tag>
              ))}
            </div>
          )}

          <div className="mt-5 flex flex-wrap gap-2">
            <button className="btn btn-primary" onClick={() => setShowStart(true)}>
              <MessageCircle className="h-4 w-4" /> {t("characters.detail.startConversationButton")}
            </button>
            <Link href={`/characters/${character.id}/edit`} className="btn btn-ghost">
              <Pencil className="h-4 w-4" /> {t("characters.detail.editButton")}
            </Link>
            <button
              className={clsx(
                "btn",
                character.is_favorite
                  ? "border border-ember-500/60 bg-ember-glow text-ember-300"
                  : "btn-ghost",
              )}
              onClick={async () => {
                const updated = await api.put<Character>(`/api/characters/${character.id}`, {
                  is_favorite: !character.is_favorite,
                });
                setCharacter(updated);
              }}
            >
              <Star className={clsx("h-4 w-4", character.is_favorite && "fill-current")} />
              {character.is_favorite ? t("characters.favoritedLabel") : t("characters.addFavoriteTitle")}
            </button>
          </div>

          {character.description && (
            <section className="mt-7">
              <h2 className="ui-label mb-2">{isScenario ? t("characters.detail.universeHeading") : t("characters.detail.aboutHeading")}</h2>
              <p className="whitespace-pre-wrap leading-relaxed text-parchment-dim">
                {previewMacros(character.description, character.name, t("chat.panel.sceneAnchor.youFallback"))}
              </p>
            </section>
          )}

          {character.greeting && (
            <section className="mt-6">
              <h2 className="ui-label mb-2">{t("characters.detail.openingHeading")}</h2>
              <blockquote className="rp-prose rounded-xl border border-ink-700 bg-ink-900/70 p-4 italic text-parchment-dim">
                {previewMacros(
                  character.greeting.length > 400
                    ? `${character.greeting.slice(0, 400)}…`
                    : character.greeting,
                  character.name,
                  t("chat.panel.sceneAnchor.youFallback"),
                )}
              </blockquote>
            </section>
          )}

          {character.creator_notes && (
            <section className="mt-6">
              <h2 className="ui-label mb-2">{t("characters.creatorNotesLabel")}</h2>
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-mist">
                {character.creator_notes}
              </p>
            </section>
          )}

          {conversations.length > 0 && (
            <section className="mt-8">
              <h2 className="ui-label mb-3">{t("characters.detail.yourConversationsHeading")}</h2>
              <div className="flex flex-col gap-2">
                {conversations.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => router.push(`/chat/${c.id}`)}
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
            </section>
          )}
        </div>
      </div>

      {showStart && (
        <StartChatModal character={character} onClose={() => setShowStart(false)} />
      )}
    </div>
  );
}

export default function CharacterPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <Suspense>
      <CharacterDetail id={id} />
    </Suspense>
  );
}
