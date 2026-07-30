"use client";

import { ChatInput } from "@/components/chat/ChatInput";
import { ChatMessage } from "@/components/chat/ChatMessage";
import { ChatSidePanel } from "@/components/chat/ChatSidePanel";
import { RpText } from "@/components/chat/RpText";
import { Avatar } from "@/components/ui/Avatar";
import { useT } from "@/i18n/useT";
import { api } from "@/lib/api";
import { streamChat } from "@/lib/sse";
import type { ContextStats, Conversation, Message, Persona, TurnPerf } from "@/types";
import { ArrowLeft, PanelRightOpen, SlidersHorizontal } from "lucide-react";
import Link from "next/link";
import { use, useCallback, useEffect, useRef, useState } from "react";

export default function ChatPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const t = useT();
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [persona, setPersona] = useState<Persona | null>(null);
  const [streamText, setStreamText] = useState<string | null>(null);
  const [regenTargetId, setRegenTargetId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(true); // desktop, inline column
  const [mobilePanelOpen, setMobilePanelOpen] = useState(false); // phone, overlay
  const [loadError, setLoadError] = useState<string | null>(null);
  const [contextStats, setContextStats] = useState<ContextStats | null>(null);
  const [perf, setPerf] = useState<TurnPerf | null>(null);
  const [titleDraft, setTitleDraft] = useState<string | null>(null);

  async function saveTitle() {
    if (titleDraft === null || !conversation) return;
    const title = titleDraft.trim();
    setTitleDraft(null);
    if (!title || title === conversation.title) return;
    await api.patch(`/api/conversations/${conversation.id}`, { title });
    setConversation((c) => (c ? { ...c, title } : c));
  }
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  useEffect(() => {
    api
      .get<Conversation>(`/api/conversations/${id}`)
      .then((convo) => {
        setConversation(convo);
        setMessages(convo.messages ?? []);
        if (convo.persona_id) {
          api.get<Persona[]>("/api/personas").then((all) =>
            setPersona(all.find((p) => p.id === convo.persona_id) ?? null),
          );
        }
      })
      .catch((e) => setLoadError(e.message));
  }, [id]);

  // Auto-scroll while streaming if the reader is already at the bottom.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages, streamText]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }, []);

  async function runTurn(
    mode: "send" | "regenerate" | "continue",
    content?: string,
    messageMode: "say" | "narrate" | "ooc" = "say",
  ) {
    if (!conversation || busy) return;
    setBusy(true);
    setError(null);
    setStreamText(mode === "continue" ? "" : "");
    stickToBottom.current = true;

    // The sent message appears instantly; the persisted version from the
    // `start` event replaces it (or it is rolled back if nothing was saved).
    const optimisticId = mode === "send" ? `optimistic-${Date.now()}` : null;
    if (optimisticId && content) {
      const lastPosition = messages.length ? messages[messages.length - 1].position : -1;
      setMessages((prev) => [...prev, {
        id: optimisticId,
        conversation_id: conversation.id,
        role: "user" as const,
        content,
        variants: [content],
        active_index: 0,
        position: lastPosition + 1,
        meta: messageMode === "say" ? {} : { mode: messageMode },
        created_at: new Date().toISOString(),
      }]);
    }
    let startReceived = false;

    if (mode === "regenerate") {
      const last = messages[messages.length - 1];
      setRegenTargetId(last?.role === "assistant" ? last.id : null);
    } else {
      setRegenTargetId(null);
    }

    const controller = new AbortController();
    abortRef.current = controller;
    let finished = false;

    try {
      await streamChat(
        { conversation_id: conversation.id, mode, content, message_mode: messageMode },
        (event) => {
          if (event.type === "start") {
            startReceived = true;
            if (event.user_message) {
              const real = event.user_message;
              setMessages((prev) => [
                ...prev.filter((m) => m.id !== optimisticId),
                real,
              ]);
            }
            if (!conversation.title && content && messageMode === "say") {
              setConversation((c) => (c ? { ...c, title: content.slice(0, 60) } : c));
            }
          } else if (event.type === "delta") {
            setStreamText((prev) => (prev ?? "") + event.text);
          } else if (event.type === "done") {
            finished = true;
            setMessages((prev) => {
              const others = prev.filter((m) => m.id !== event.message.id);
              return [...others, event.message].sort((a, b) => a.position - b.position);
            });
            if (event.context) setContextStats(event.context);
            if (event.perf) setPerf(event.perf);
          } else if (event.type === "error") {
            finished = true;
            setError(event.message);
          }
        },
        controller.signal,
      );
      if (!finished) {
        // Stream closed without done/error (aborted server-side?) — resync.
        await reload();
      }
    } catch (e) {
      if (controller.signal.aborted) {
        await reload(); // backend persisted the partial text
      } else {
        setError(e instanceof Error ? e.message : t("chat.errors.connectionFailed"));
      }
    }

    // Transport died or the turn failed before anything was persisted:
    // withdraw the optimistic bubble so the display matches the server.
    if (optimisticId && !startReceived) {
      setMessages((prev) => prev.filter((m) => m.id !== optimisticId));
    }

    setStreamText(null);
    setRegenTargetId(null);
    setBusy(false);
    abortRef.current = null;
  }

  async function reload() {
    if (!conversation) return;
    try {
      const convo = await api.get<Conversation>(`/api/conversations/${conversation.id}`);
      setMessages(convo.messages ?? []);
    } catch {
      /* keep current state */
    }
  }

  async function swipe(message: Message, index: number) {
    const updated = await api.patch<Message>(`/api/messages/${message.id}`, {
      active_index: index,
    });
    setMessages((prev) => prev.map((m) => (m.id === message.id ? updated : m)));
  }

  async function edit(message: Message, content: string) {
    const updated = await api.patch<Message>(`/api/messages/${message.id}`, { content });
    setMessages((prev) => prev.map((m) => (m.id === message.id ? updated : m)));
  }

  async function deleteFrom(message: Message) {
    if (!confirm(t("chat.message.confirmDeleteFrom"))) return;
    await api.delete(`/api/messages/${message.id}?following=true`);
    setMessages((prev) => prev.filter((m) => m.position < message.position));
  }

  async function branchFrom(message: Message) {
    if (!confirm(t("chat.message.confirmBranch"))) return;
    const branch = await api.post<Conversation>(`/api/messages/${message.id}/branch`);
    window.location.href = `/chat/${branch.id}`;
  }

  if (loadError) {
    return (
      <div className="p-10">
        <p className="text-blood">{loadError}</p>
        <Link href="/chat" className="btn btn-ghost mt-4">
          <ArrowLeft className="h-4 w-4" /> {t("nav.conversations")}
        </Link>
      </div>
    );
  }
  if (!conversation?.character) {
    return <div className="p-10 text-mist animate-pulse-soft">{t("chat.openingScene")}</div>;
  }

  const character = conversation.character;
  const lastMessage = messages[messages.length - 1];
  // While regenerating an existing message, hide it (its replacement streams below).
  const visibleMessages = regenTargetId && streamText !== null
    ? messages.filter((m) => m.id !== regenTargetId)
    : messages;

  return (
    <div className="flex h-full">
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Header */}
        <header className="flex items-center gap-3 border-b border-ink-700 bg-ink-900 px-4 py-3 md:bg-ink-900/80 md:backdrop-blur">
          <Link
            href="/chat"
            className="rounded-lg p-1.5 text-mist transition-colors hover:bg-ink-800 hover:text-parchment"
            aria-label={t("chat.header.backAriaLabel")}
          >
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <Avatar name={character.name} src={character.avatar_url} className="h-9 w-9 text-base" />
          <div className="min-w-0">
            <h1 className="truncate font-display font-semibold leading-tight">{character.name}</h1>
            {titleDraft !== null ? (
              <input
                className="field !w-64 !rounded-md !px-1.5 !py-0 text-xs"
                value={titleDraft}
                autoFocus
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={saveTitle}
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveTitle();
                  if (e.key === "Escape") setTitleDraft(null);
                }}
              />
            ) : (
              <button
                className="block max-w-64 truncate text-left text-xs text-mist transition-colors hover:text-parchment"
                onClick={() => setTitleDraft(conversation.title || "")}
                title={t("chat.header.renameTitle")}
              >
                {conversation.title || t("chatList.newConversationFallback")}
              </button>
            )}
          </div>
          <div className="ml-auto flex items-center gap-3">
            {contextStats && (
              <div
                className="hidden items-center gap-2 sm:flex"
                title={
                  `${t("chat.context.tooltipUsage", { used: contextStats.used_tokens, budget: contextStats.budget, size: contextStats.context_size })}\n` +
                  `${t("chat.context.tooltipMessages", { included: contextStats.messages_included, total: contextStats.messages_total })}` +
                  (contextStats.messages_included < contextStats.messages_total
                    ? ` ${t("chat.context.tooltipOlderInMemory")}`
                    : "") +
                  (contextStats.lore_matched
                    ? `\n${t("chat.context.tooltipLore", { count: contextStats.lore_matched })}`
                    : "")
                }
              >
                <div className="h-1.5 w-20 overflow-hidden rounded-full bg-ink-700">
                  <div
                    className="h-full rounded-full bg-ember-500 transition-all"
                    style={{ width: `${Math.min(100, Math.round((contextStats.used_tokens / contextStats.budget) * 100))}%` }}
                  />
                </div>
                <span className="font-mono text-[0.68rem] text-mist-dim">
                  {t("chat.context.percent", { pct: Math.round((contextStats.used_tokens / contextStats.budget) * 100) })}
                  {perf?.tokens_per_s ? ` · ${t("chat.context.perSecond", { tps: perf.tokens_per_s })}` : ""}
                </span>
              </div>
            )}
            <button
              onClick={() => setMobilePanelOpen(true)}
              className="rounded-lg p-2 text-mist transition-colors hover:bg-ink-800 hover:text-parchment md:hidden"
              aria-label={t("chat.header.memorySettingsAriaLabel")}
            >
              <SlidersHorizontal className="h-5 w-5" />
            </button>
            {!panelOpen && (
              <button
                onClick={() => setPanelOpen(true)}
                className="hidden rounded-lg p-1.5 text-mist transition-colors hover:bg-ink-800 hover:text-parchment md:block"
                aria-label={t("chat.header.openPanelAriaLabel")}
              >
                <PanelRightOpen className="h-5 w-5" />
              </button>
            )}
          </div>
        </header>

        {/* Messages */}
        <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl px-4 py-6">
            {visibleMessages.map((message, i) => (
              <ChatMessage
                key={message.id}
                message={message}
                character={character}
                persona={persona}
                isLast={i === visibleMessages.length - 1 && message.role === "assistant"}
                busy={busy}
                onSwipe={(index) => swipe(message, index)}
                onRegenerate={() => runTurn("regenerate")}
                onContinue={() => runTurn("continue")}
                onEdit={(content) => edit(message, content)}
                onDeleteFrom={() => deleteFrom(message)}
                onBranch={() => branchFrom(message)}
              />
            ))}

            {/* Streaming bubble */}
            {streamText !== null && (
              <div className="flex gap-3.5 px-1 py-3">
                <Avatar
                  name={character.name}
                  src={character.avatar_url}
                  className="mt-0.5 h-10 w-10 shrink-0 text-lg"
                />
                <div className="min-w-0 flex-1">
                  <span className="font-display text-[0.95rem] font-semibold text-ember-300">
                    {character.name}
                  </span>
                  <div className="mt-1">
                    {streamText ? (
                      <RpText text={streamText} streaming />
                    ) : (
                      <span className="text-mist animate-pulse-soft italic">
                        {t("chat.stream.assistantTyping", { name: character.name })}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            )}

            {error && (
              <div className="mx-1 my-3 flex items-center justify-between gap-4 rounded-xl border border-blood/40 bg-blood/10 px-4 py-3">
                <p className="text-sm text-blood">{error}</p>
                {lastMessage && (
                  <button className="btn btn-ghost shrink-0 !py-1.5 text-xs" onClick={() => runTurn("regenerate")}>
                    {t("chat.errors.retryButton")}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        <ChatInput
          key={conversation.id}
          conversationId={conversation.id}
          onSend={(content, messageMode) => runTurn("send", content, messageMode)}
          onStop={() => abortRef.current?.abort()}
          busy={busy}
          characterName={character.name}
        />
      </div>

      {/* Desktop: inline right column */}
      {panelOpen && (
        <ChatSidePanel
          conversation={conversation}
          persona={persona}
          onClose={() => setPanelOpen(false)}
          onConversationChange={(patch) =>
            setConversation((c) => (c ? { ...c, ...patch } : c))
          }
          className="hidden w-80 border-l md:flex"
        />
      )}

      {/* Phone: full-screen overlay */}
      {mobilePanelOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <ChatSidePanel
            conversation={conversation}
            persona={persona}
            onClose={() => setMobilePanelOpen(false)}
            onConversationChange={(patch) =>
              setConversation((c) => (c ? { ...c, ...patch } : c))
            }
            className="h-full w-full animate-rise"
          />
        </div>
      )}
    </div>
  );
}
