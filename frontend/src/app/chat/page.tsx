"use client";

import { Avatar } from "@/components/ui/Avatar";
import { EmptyState } from "@/components/ui/EmptyState";
import { useT } from "@/i18n/useT";
import { api } from "@/lib/api";
import { clearDraft, pruneDrafts } from "@/lib/drafts";
import { timeAgo } from "@/lib/utils";
import type { Conversation } from "@/types";
import { GitBranch, MessagesSquare, Pencil, PenLine, Trash2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

export default function ConversationsPage() {
  const t = useT();
  const [conversations, setConversations] = useState<Conversation[] | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [withDraft, setWithDraft] = useState<Set<string>>(new Set());

  async function saveRename(convo: Conversation) {
    const title = renameDraft.trim();
    setRenamingId(null);
    if (!title || title === convo.title) return;
    await api.patch(`/api/conversations/${convo.id}`, { title });
    setConversations((prev) =>
      prev ? prev.map((c) => (c.id === convo.id ? { ...c, title } : c)) : prev,
    );
  }

  const load = () =>
    api.get<Conversation[]>("/api/conversations").then((list) => {
      setConversations(list);
      // also drops drafts left behind by conversations deleted elsewhere
      setWithDraft(pruneDrafts(list.map((c) => c.id)));
    });
  useEffect(() => {
    load();
  }, []);

  async function remove(e: React.MouseEvent, convo: Conversation) {
    e.preventDefault();
    e.stopPropagation();
    if (!confirm(t("chatList.confirmDelete", { title: convo.title || t("chatList.untitled") })))
      return;
    await api.delete(`/api/conversations/${convo.id}`);
    clearDraft(convo.id);
    load();
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <header className="mb-8 animate-rise">
        <h1 className="font-display text-3xl font-semibold">{t("nav.conversations")}</h1>
        <p className="mt-1 text-mist">{t("chatList.subtitle")}</p>
      </header>

      {conversations === null ? (
        <div className="text-mist animate-pulse-soft">{t("common.loading")}</div>
      ) : conversations.length === 0 ? (
        <EmptyState icon={MessagesSquare} title={t("chatList.emptyState.title")}>
          {t("chatList.emptyState.body")}
        </EmptyState>
      ) : (
        <div className="stagger flex flex-col gap-3">
          {conversations.map((convo) => (
            <Link
              key={convo.id}
              href={`/chat/${convo.id}`}
              className="group panel flex items-center gap-4 px-5 py-4 transition-all hover:-translate-y-0.5 hover:border-ember-600/40"
            >
              <Avatar
                name={convo.character?.name ?? "?"}
                src={convo.character?.avatar_url}
                className="h-12 w-12 shrink-0 text-lg"
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <h2 className="truncate font-display font-semibold">
                    {convo.character?.name ?? t("chatList.deletedCharacter")}
                  </h2>
                  {convo.forked_from && (
                    <span className="flex shrink-0 items-center gap-1 rounded-full border border-arcane-500/40 bg-arcane-glow px-2 py-0.5 font-display text-[0.65rem] text-arcane-300">
                      <GitBranch className="h-2.5 w-2.5" /> {t("chatList.forkedBadge")}
                    </span>
                  )}
                  {withDraft.has(convo.id) && (
                    <span
                      className="flex shrink-0 items-center gap-1 rounded-full border border-ember-600/40 bg-ember-glow px-2 py-0.5 font-display text-[0.65rem] text-ember-300"
                      title={t("chatList.draftTooltip")}
                    >
                      <PenLine className="h-2.5 w-2.5" /> {t("chatList.draftBadge")}
                    </span>
                  )}
                  <span className="shrink-0 text-xs text-mist-dim">
                    {timeAgo(convo.last_message_at ?? convo.updated_at, t)}
                  </span>
                </div>
                {renamingId === convo.id ? (
                  <input
                    className="field mt-0.5 !w-full !rounded-md !px-1.5 !py-0.5 text-sm"
                    value={renameDraft}
                    autoFocus
                    onClick={(e) => e.preventDefault()}
                    onChange={(e) => setRenameDraft(e.target.value)}
                    onBlur={() => saveRename(convo)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") saveRename(convo);
                      if (e.key === "Escape") setRenamingId(null);
                    }}
                  />
                ) : (
                  <p className="truncate text-sm text-mist">
                    {convo.title || t("chatList.newConversationFallback")} ·{" "}
                    {t("chatList.messageCount", { count: convo.message_count ?? 0 })}
                  </p>
                )}
              </div>
              <button
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setRenameDraft(convo.title || "");
                  setRenamingId(convo.id);
                }}
                className="hover-actions rounded-lg p-2 text-mist-dim hover:bg-ink-700 hover:text-parchment"
                aria-label={t("chatList.renameLabel")}
              >
                <Pencil className="h-4 w-4" />
              </button>
              <button
                onClick={(e) => remove(e, convo)}
                className="hover-actions rounded-lg p-2 text-mist-dim hover:bg-blood/15 hover:text-blood"
                aria-label={t("common.delete")}
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
