"use client";

import { ChatInput } from "@/components/chat/ChatInput";
import { ChatMessage } from "@/components/chat/ChatMessage";
import { ChatSidePanel } from "@/components/chat/ChatSidePanel";
import { RpText } from "@/components/chat/RpText";
import { Avatar } from "@/components/ui/Avatar";
import { useT } from "@/i18n/useT";
import { api } from "@/lib/api";
import { followTurn, streamChat } from "@/lib/sse";
import { turnStore } from "@/lib/turnStore";
import type { ContextStats, Conversation, Message, Persona, TurnPerf } from "@/types";
import { ArrowLeft, PanelRightOpen, SlidersHorizontal } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

export default function ChatPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const t = useT();
  const router = useRouter();
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [persona, setPersona] = useState<Persona | null>(null);
  // Read from the store rather than held here: leaving the page used to throw
  // this away while the reply carried on arriving.
  const turn = useSyncExternalStore(turnStore.subscribe, turnStore.read, turnStore.readServer);
  const streamText = turn?.conversationId === id ? turn.text : null;
  const busy = turn?.conversationId === id && turn.busy;
  const [regenTargetId, setRegenTargetId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(true); // desktop, inline column
  // Phones: the panel covers the conversation, so a backdrop cannot be judged
  // from inside it. Adjusting closes the panel and leaves a bar over the real
  // thing instead.
  const [adjustingWallpaper, setAdjustingWallpaper] = useState(false);
  const opacityWrite = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  /** Live on every pixel of the drag, written once it settles: a range input
   *  fires continuously and each of those would otherwise be a write. */
  function setWallpaperOpacity(value: number) {
    setConversation((c) => (c ? { ...c, wallpaper_opacity: value } : c));
    if (opacityWrite.current) clearTimeout(opacityWrite.current);
    opacityWrite.current = setTimeout(() => {
      api.patch(`/api/conversations/${id}`, { wallpaper_opacity: value }).catch(() => {});
    }, 350);
  }

  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  useEffect(() => {
    api
      .get<Conversation>(`/api/conversations/${id}`)
      .then((convo) => {
        setConversation(convo);
        setMessages(convo.messages ?? []);
        if (convo.persona_id) {
          api.get<Persona[]>("/api/personas")
            .then((all) => setPersona(all.find((p) => p.id === convo.persona_id) ?? null))
            .catch(() => {});
        }
      })
      .catch((e) => setLoadError(e.message));
  }, [id]);

  // A reply may be being written for this conversation right now, by a server
  // that carried on after the phone that asked for it went to sleep. Attach to
  // it and watch the rest arrive, rather than showing a conversation that looks
  // finished and is not.
  /** Watch a reply that is being written elsewhere — by a server that carried
   *  on after the phone that asked for it went to sleep. Used on arriving at
   *  the conversation, and again after a connection comes back. */
  const attachToRunningTurn = useCallback(async (controller: AbortController) => {
    if (turnStore.isRunning(id)) return; // this page is already the one running it
    const state = await api
      .get<{ running: boolean }>(`/api/conversations/${id}/turn`)
      .catch(() => ({ running: false }));
    if (!state.running || controller.signal.aborted) return;
    turnStore.begin(id, controller);
    try {
      await followTurn(id, (event) => {
        // The replay starts at the beginning, so this is the same `start` the
        // page that asked for the turn saw. A regeneration replaces a reply
        // rather than adding one; without knowing which, the page shows both
        // the old reply and its replacement arriving underneath.
        if (event.type === "start") {
          setRegenTargetId(event.target_message_id ?? null);
        } else if (event.type === "delta") {
          turnStore.append(event.text);
        } else if (event.type === "done") {
          setMessages((prev) => {
            const others = prev.filter((m) => m.id !== event.message.id);
            return [...others, event.message].sort((a, b) => a.position - b.position);
          });
        }
      }, controller.signal);
    } catch {
      /* the reply is saved as it goes; a resync will find it */
    } finally {
      turnStore.end();
      setRegenTargetId(null);
    }
  }, [id]);

  useEffect(() => {
    const controller = new AbortController();
    void attachToRunningTurn(controller);
    return () => controller.abort();
  }, [attachToRunningTurn]);

  /** Fetch the conversation again. Returns whether Evermind answered: callers
   *  that lost a connection use that to tell "the reply landed while we were
   *  away" from "the server is not there". */
  const reload = useCallback(async () => {
    if (!conversation) return true;
    try {
      const convo = await api.get<Conversation>(`/api/conversations/${conversation.id}`);
      setMessages(convo.messages ?? []);
      return true;
    } catch {
      return false; // keep current state
    }
  }, [conversation]);

  // The closure that updates the message list belongs to whichever page instance
  // started the turn. Arrive after it started, or come back to it, and nothing
  // would tell this instance the reply had landed: watch the turn end instead.
  // What was already on screen when this page started the current turn. The
  // filter below hides a reply marked as still being written, so that a page
  // opened mid-turn does not show the same text twice; one that was already
  // here predates the turn and is not what is being written.
  const [beforeTurn, setBeforeTurn] = useState<Set<string>>(new Set());

  const wasBusy = useRef(false);
  useEffect(() => {
    if (busy) {
      wasBusy.current = true;
      return;
    }
    if (wasBusy.current) {
      wasBusy.current = false;
      reload();
    }
  }, [busy, reload]);

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
    setError(null);
    stickToBottom.current = true;
    const controller = new AbortController();
    setBeforeTurn(new Set(messages.map((m) => m.id)));
    turnStore.begin(conversation.id, controller);

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
            turnStore.append(event.text);
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
        // Whether the turn ever began is what decides this, and `start` is how
        // we know. Losing the connection after it began is not losing the
        // reply — the turn belongs to the server and finishes without us — so
        // there is nothing to report and everything to resync. Failing before
        // it began means the message may never have been sent, which is worth
        // saying.
        //
        // Asking instead whether a turn is *still* running was not enough: come
        // back an hour later and of course it is not, so a reply that had landed
        // perfectly well was reported as a network error until the page was
        // reloaded by hand.
        const reachable = await reload();
        if (!startReceived || !reachable) {
          setError(e instanceof Error ? e.message : t("chat.errors.connectionFailed"));
        } else {
          // If the reply is still being written, pick it back up rather than
          // leaving the conversation looking finished.
          void attachToRunningTurn(new AbortController());
        }
      }
    }

    // Transport died or the turn failed before anything was persisted:
    // withdraw the optimistic bubble so the display matches the server.
    if (optimisticId && !startReceived) {
      setMessages((prev) => prev.filter((m) => m.id !== optimisticId));
    }

    turnStore.end();
    setRegenTargetId(null);
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
    router.push(`/chat/${branch.id}`);
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
  // While regenerating an existing message, hide it (its replacement streams
  // below). A reply still being written is hidden the same way while its turn is
  // live: the backend saves it as it goes, so arriving mid-turn would otherwise
  // show the same text twice, once from the database and once from the stream.
  // Only one that arrived with the turn, though. A reply left marked from an
  // earlier turn that was cut off was hidden too, so it disappeared for the
  // length of every later generation — including the one continuing it.
  const visibleMessages = messages.filter((m) => {
    if (regenTargetId && streamText !== null && m.id === regenTargetId) return false;
    if (busy && m.meta?.streaming && !beforeTurn.has(m.id)) return false;
    return true;
  });

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
        <div ref={scrollRef} onScroll={onScroll} className="relative flex-1 overflow-y-auto">
          {conversation.wallpaper_url && (
            // Pinned to the column rather than scrolled with the text: a
            // backdrop that slides past is a picture in the conversation, not
            // behind it. aria-hidden — it says nothing a reader needs.
            <div aria-hidden className="pointer-events-none sticky top-0 h-0 w-full">
              <div
                className="h-[100dvh] w-full bg-cover bg-center bg-no-repeat"
                style={{
                  backgroundImage: `url(${conversation.wallpaper_url})`,
                  opacity: conversation.wallpaper_opacity ?? 0.25,
                }}
              />
            </div>
          )}
          <div className="relative mx-auto max-w-3xl px-4 py-6">
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
          onStop={() => turnStore.stop()}
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
          onWallpaperOpacity={setWallpaperOpacity}
          onAdjustWallpaper={() => {
            setMobilePanelOpen(false);
            setAdjustingWallpaper(true);
          }}
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
            onWallpaperOpacity={setWallpaperOpacity}
            onAdjustWallpaper={() => {
              setMobilePanelOpen(false);
              setAdjustingWallpaper(true);
            }}
            className="h-full w-full animate-rise"
          />
        </div>
      )}

      {/* Phone: judging a backdrop means seeing what sits on it, so the panel
          gets out of the way and only this stays. */}
      {adjustingWallpaper && conversation.wallpaper_url && (
        <div
          className="fixed inset-x-0 bottom-0 z-40 border-t border-ink-700 bg-ink-950/90 px-4 pt-4 backdrop-blur md:hidden"
          style={{ paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }}
        >
          <div className="mb-2 flex items-center justify-between text-sm">
            <span className="text-mist">{t("chat.wallpaper.opacity")}</span>
            <span className="tabular-nums text-parchment-dim">
              {Math.round((conversation.wallpaper_opacity ?? 0.25) * 100)}%
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round((conversation.wallpaper_opacity ?? 0.25) * 100)}
            onChange={(e) => setWallpaperOpacity(Number(e.target.value) / 100)}
            className="w-full accent-[#e29a3e]"
            aria-label={t("chat.wallpaper.opacity")}
          />
          <button
            type="button"
            className="btn btn-primary mt-3 w-full"
            onClick={() => setAdjustingWallpaper(false)}
          >
            {t("chat.wallpaper.done")}
          </button>
        </div>
      )}
    </div>
  );
}
