import { CardSummary } from "@/components/chat/CardSummary";
import { Avatar } from "@/components/ui/Avatar";
import { EmptyState } from "@/components/ui/EmptyState";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { data } from "@/data";
import { useT } from "@/i18n/useT";
import { clearDraft, pruneDrafts } from "@/lib/drafts";
import { describeError } from "@/lib/errors";
import { timeAgo } from "@/lib/utils";
import type { Conversation, Persona } from "@/types";
import { BookOpenText, GitBranch, MessagesSquare, Pencil, PenLine, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router";

export function ChatListPage() {
  const t = useT();
  // The conversation whose card is shown in short, and the personas, for the {{user}} of its card.
  const [summaryOf, setSummaryOf] = useState<Conversation | null>(null);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [conversations, setConversations] = useState<Conversation[] | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [withDraft, setWithDraft] = useState<Set<string>>(new Set());
  const [failure, setFailure] = useState<{ error: unknown } | null>(null);
  // Said on the conversation it was asked of, until the next change.
  const [writeError, setWriteError] = useState<{ id: string; error: unknown } | null>(null);

  /** A change asked of one conversation, and whether the server took it. */
  async function write(id: string, change: () => Promise<unknown>) {
    setWriteError(null);
    try {
      await change();
      return true;
    } catch (error) {
      setWriteError({ id, error });
      // It may have gone through all the same; a list that cannot be read either stays as it is.
      data.conversations.list().then(setConversations, () => {});
      return false;
    }
  }

  async function saveRename(convo: Conversation) {
    const title = renameDraft.trim();
    setRenamingId(null);
    if (!title || title === convo.title) return;
    if (await write(convo.id, () => data.conversations.update(convo.id, { title }))) {
      setConversations((prev) =>
        prev ? prev.map((c) => (c.id === convo.id ? { ...c, title } : c)) : prev,
      );
    }
  }

  const load = () => {
    // Without them a card says "you" for {{user}}: no reason to fail the list over it. Read again
    // with the list, so that Retry after a failed first load brings them back too.
    data.personas.list().then(setPersonas, () => {});
    return data.conversations
      .list()
      .then((list) => {
        setConversations(list);
        setFailure(null);
        // also drops drafts left behind by conversations deleted elsewhere
        setWithDraft(pruneDrafts(list.map((c) => c.id)));
      })
      .catch((error) => setFailure({ error }));
  };
  useEffect(() => {
    load();
  }, []);

  async function remove(e: React.MouseEvent, convo: Conversation) {
    e.preventDefault();
    e.stopPropagation();
    if (!confirm(t("chatList.confirmDelete", { title: convo.title || t("chatList.untitled") })))
      return;
    if (await write(convo.id, () => data.conversations.remove(convo.id))) {
      clearDraft(convo.id);
      load();
    }
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <header className="mb-8 animate-rise">
        <h1 className="font-display text-3xl font-semibold">{t("nav.conversations")}</h1>
        <p className="mt-1 text-mist">{t("chatList.subtitle")}</p>
      </header>

      {failure ? (
        <LoadFailure error={failure.error} onRetry={load} />
      ) : conversations === null ? (
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
              to={`/chat/${convo.id}`}
              className="group panel flex flex-wrap items-center gap-4 px-5 py-4 transition-all hover:-translate-y-0.5 hover:border-ember-600/40"
            >
              {convo.character ? (
                // The card in short, as from the conversation's own header; the rest of the row opens the conversation.
                <button
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setSummaryOf(convo);
                  }}
                  className="shrink-0 rounded-xl transition-opacity hover:opacity-80"
                  aria-label={t("chat.cardSummary.aboutAriaLabel", { name: convo.character.name })}
                  title={t("chat.cardSummary.aboutAriaLabel", { name: convo.character.name })}
                  aria-haspopup="dialog"
                >
                  <Avatar name={convo.character.name} src={convo.character.avatar_url} className="h-12 w-12 text-lg" />
                </button>
              ) : (
                <Avatar name="?" className="h-12 w-12 shrink-0 text-lg" />
              )}
              <div className="min-w-0 flex-1">
                {/* Below sm a badge is its icon, its word kept for a screen reader: on a phone the line has
                    about 140px, and the words would push the name out of it. */}
                <div className="flex items-baseline gap-2">
                  <h2 className="truncate font-display font-semibold">
                    {convo.character?.name ?? t("chatList.deletedCharacter")}
                  </h2>
                  {convo.character?.kind === "scenario" && (
                    <span
                      className="flex shrink-0 items-center gap-1 rounded-full border border-arcane-500/40 bg-arcane-glow px-1.5 py-0.5 font-display text-[0.65rem] text-arcane-300 sm:px-2"
                      title={t("chat.panel.kindScenario")}
                    >
                      <BookOpenText className="h-2.5 w-2.5" />
                      <span className="sr-only sm:not-sr-only">{t("chat.panel.kindScenario")}</span>
                    </span>
                  )}
                  {convo.forked_from && (
                    <span
                      className="flex shrink-0 items-center gap-1 rounded-full border border-arcane-500/40 bg-arcane-glow px-1.5 py-0.5 font-display text-[0.65rem] text-arcane-300 sm:px-2"
                      title={t("chatList.forkedBadge")}
                    >
                      <GitBranch className="h-2.5 w-2.5" />
                      <span className="sr-only sm:not-sr-only">{t("chatList.forkedBadge")}</span>
                    </span>
                  )}
                  {withDraft.has(convo.id) && (
                    <span
                      className="flex shrink-0 items-center gap-1 rounded-full border border-ember-600/40 bg-ember-glow px-1.5 py-0.5 font-display text-[0.65rem] text-ember-300 sm:px-2"
                      title={t("chatList.draftTooltip")}
                    >
                      <PenLine className="h-2.5 w-2.5" />
                      <span className="sr-only sm:not-sr-only">{t("chatList.draftBadge")}</span>
                    </span>
                  )}
                  {/* Below sm on the second line, where the title gives way to it, not the name. */}
                  <span className="hidden shrink-0 text-xs text-mist-dim sm:inline">
                    {timeAgo(convo.last_message_at ?? convo.updated_at, t)}
                  </span>
                </div>
                {renamingId === convo.id ? (
                  <input
                    className="field mt-0.5 !min-h-0 !w-full !rounded-md !px-1.5 !py-0.5 text-sm"
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
                    <span className="sm:hidden">{timeAgo(convo.last_message_at ?? convo.updated_at, t)} · </span>
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
                className="hover-actions rounded-lg p-2 text-mist-dim hover:bg-ink-700 hover:text-parchment pointer-coarse:p-3.5"
                aria-label={t("chatList.renameLabel")}
              >
                <Pencil className="h-4 w-4" />
              </button>
              <button
                onClick={(e) => remove(e, convo)}
                className="hover-actions rounded-lg p-2 text-mist-dim hover:bg-blood/15 hover:text-blood pointer-coarse:p-3.5"
                aria-label={t("common.delete")}
              >
                <Trash2 className="h-4 w-4" />
              </button>
              {writeError?.id === convo.id && (
                <p
                  role="alert"
                  className="basis-full rounded-lg border border-blood/40 bg-blood/10 px-3 py-2 text-sm text-blood"
                >
                  {describeError(writeError.error, t)}
                </p>
              )}
            </Link>
          ))}
        </div>
      )}
      {summaryOf?.character && (
        <CardSummary
          character={summaryOf.character}
          personaName={personas.find((p) => p.id === summaryOf.persona_id)?.name ?? null}
          onClose={() => setSummaryOf(null)}
        />
      )}
    </div>
  );
}
