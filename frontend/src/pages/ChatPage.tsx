import { ChatInput } from "@/components/chat/ChatInput";
import { ChatMessage } from "@/components/chat/ChatMessage";
import { ModelSilent } from "@/components/chat/ModelSilent";
import { ChatSidePanel } from "@/components/chat/ChatSidePanel";
import { RpText } from "@/components/chat/RpText";
import { Avatar } from "@/components/ui/Avatar";
import { data } from "@/data";
import { useT } from "@/i18n/useT";
import { describeError, describeEvent } from "@/lib/errors";
import { turnStore } from "@/lib/turnStore";
import type { ChatEvent, ContextStats, Conversation, Message, Persona, TurnPerf } from "@/types";
import { ArrowLeft, PanelRightOpen, SlidersHorizontal } from "lucide-react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Link, useNavigate, useParams } from "react-router";

/** Keyed by the id, so that a branch, which opens at an address of its own,
 *  starts from its own messages rather than from the ones it was cut from. */
export function ChatPage() {
  const { id = "" } = useParams();
  return <ChatView key={id} id={id} />;
}

function ChatView({ id }: { id: string }) {
  const t = useT();
  const navigate = useNavigate();
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [persona, setPersona] = useState<Persona | null>(null);
  // Read from the store rather than held here: leaving the page used to throw
  // this away while the reply carried on arriving.
  const turn = useSyncExternalStore(turnStore.subscribe, turnStore.read);
  const streamText = turn?.conversationId === id ? turn.text : null;
  const busy = turn?.conversationId === id && turn.busy;
  const [regenTargetId, setRegenTargetId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(true); // desktop, inline column
  // Phones: the panel covers the conversation, so a backdrop cannot be judged
  // from inside it. Adjusting closes the panel and leaves a bar over the real
  // thing instead.
  const [adjustingWallpaper, setAdjustingWallpaper] = useState(false);
  const [silent, setSilent] = useState(false);
  const opacityWrite = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [mobilePanelOpen, setMobilePanelOpen] = useState(false); // phone, overlay
  // The error itself, described when drawn, so that a change of language
  // reaches the sentence too.
  const [loadFailure, setLoadFailure] = useState<{ error: unknown } | null>(null);
  const [connectionLost, setConnectionLost] = useState<{ error: unknown } | null>(null);
  const [contextStats, setContextStats] = useState<ContextStats | null>(null);
  const [perf, setPerf] = useState<TurnPerf | null>(null);
  const [titleDraft, setTitleDraft] = useState<string | null>(null);

  async function saveTitle() {
    if (titleDraft === null || !conversation) return;
    const title = titleDraft.trim();
    setTitleDraft(null);
    if (!title || title === conversation.title) return;
    await data.conversations.update(conversation.id, { title });
    setConversation((c) => (c ? { ...c, title } : c));
  }

  /** Live on every pixel of the drag, written once it settles: a range input
   *  fires continuously and each of those would otherwise be a write. */
  function setWallpaperOpacity(value: number) {
    setConversation((c) => (c ? { ...c, wallpaper_opacity: value } : c));
    if (opacityWrite.current) clearTimeout(opacityWrite.current);
    opacityWrite.current = setTimeout(() => {
      data.conversations.update(id, { wallpaper_opacity: value }).catch(() => {});
    }, 350);
  }

  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  /** A connection to a turn broke: a phone went to sleep, or lost its wifi. The
   *  turn is the server's and has not noticed, so read it again, from its first
   *  word, which is where a reader starts; what had arrived stays up until those
   *  words are back, and so does the stop button. If nothing is running any more
   *  the reply has landed, and the page reads it when the turn ends, as it always
   *  does. This is tried once. If it fails too the person is told, rather than
   *  left looking at a reply that has silently stopped. */
  const pickTurnBackUp = useCallback(
    async (controller: AbortController, onEvent: (event: ChatEvent) => void) => {
      try {
        if (!(await data.turns.state(id)).running) return;
        await data.turns.follow(id, (event) => {
          if (event.type === "start") turnStore.begin(id, controller);
          onEvent(event);
        }, controller.signal);
      } catch (error) {
        if (!controller.signal.aborted) setConnectionLost({ error });
      }
    },
    [id],
  );

  /** Watch a reply that is being written elsewhere — by a server that carried
   *  on after the phone that asked for it went to sleep. Says whether there was
   *  a turn to watch. */
  const attachToRunningTurn = useCallback(async (controller: AbortController) => {
    if (turnStore.isRunning(id)) return true; // this page is already the one running it
    const state = await data.turns.state(id).catch(() => ({ running: false }));
    if (!state.running || controller.signal.aborted) return false;
    turnStore.begin(id, controller);
    const onEvent = (event: ChatEvent) => {
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
    };
    try {
      await data.turns.follow(id, onEvent, controller.signal);
    } catch {
      if (!controller.signal.aborted) await pickTurnBackUp(controller, onEvent);
    } finally {
      turnStore.end();
      setRegenTargetId(null);
    }
    return true;
  }, [id, pickTurnBackUp]);

  useEffect(() => {
    const controller = new AbortController();
    const opening = data.conversations.get(id);
    opening
      .then((convo) => {
        setConversation(convo);
        setMessages(convo.messages ?? []);
        if (convo.persona_id) {
          data.personas
            .list()
            .then((all) => setPersona(all.find((p) => p.id === convo.persona_id) ?? null))
            .catch(() => {});
        }
      })
      .catch((error) => setLoadFailure({ error }));

    // The conversation and the state of the turn are two reads, not one moment.
    // A turn that ended between them leaves a reply as far as it had got, with no
    // turn to watch and so nothing coming to replace it. What was read cannot say:
    // only a new reply is marked while it is written, a regeneration or a
    // continuation looks finished at every word. So it is read once more, which is
    // enough: nothing was running when this one was asked for. Nearly always it
    // says the same, and then what is on screen is left alone rather than every
    // message being drawn twice.
    void (async () => {
      if ((await attachToRunningTurn(controller)) || controller.signal.aborted) return;
      await opening;
      const latest = (await data.conversations.get(id)).messages ?? [];
      if (controller.signal.aborted || turnStore.isRunning(id)) return;
      setMessages((shown) => (JSON.stringify(shown) === JSON.stringify(latest) ? shown : latest));
    })().catch(() => {
      /* whatever was read first stays on screen, or its failure is reported above */
    });

    return () => controller.abort();
  }, [id, attachToRunningTurn]);

  /** Fetch the conversation again. */
  const reload = useCallback(async () => {
    if (!conversation) return;
    try {
      const convo = await data.conversations.get(conversation.id);
      setMessages(convo.messages ?? []);
    } catch {
      /* keep current state */
    }
  }, [conversation]);

  // What was already on screen when this page started the current turn. The
  // filter below hides a reply marked as still being written, so that a page
  // opened mid-turn does not show the same text twice; one that was already
  // here predates the turn and is not what is being written.
  const [beforeTurn, setBeforeTurn] = useState<Set<string>>(new Set());

  // The closure that updates the message list belongs to whichever page instance
  // started the turn. Arrive after it started, or come back to it, and nothing
  // would tell this instance the reply had landed: watch the turn end instead.
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
    setConnectionLost(null);
    setSilent(false);
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

    const onEvent = (event: ChatEvent) => {
      if (event.type === "start") {
        startReceived = true;
        if (event.user_message) {
          const real = event.user_message;
          // Not added twice: a turn picked back up is read from its start again.
          setMessages((prev) => [
            ...prev.filter((m) => m.id !== optimisticId && m.id !== real.id),
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
        // A model that never answered is not a fault to raise the alarm
        // about; usually the server behind it is simply not running.
        if (event.kind === "unreachable") setSilent(true);
        else setError(describeEvent(event, t));
      }
    };

    try {
      await data.turns.send(
        { conversation_id: conversation.id, mode, content, message_mode: messageMode },
        onEvent,
        controller.signal,
      );
      if (!finished) {
        // Stream closed without done/error (aborted server-side?) — resync.
        await reload();
      }
    } catch (e) {
      if (controller.signal.aborted) {
        await reload(); // backend persisted the partial text
      } else if (startReceived) {
        // Whether the turn ever began is what decides this, and `start` is how
        // we know. Losing the connection after it began is not losing the
        // reply — the turn belongs to the server and finishes without us — so
        // there is nothing to report and everything to pick back up.
        //
        // Asking instead whether a turn is *still* running was not enough: come
        // back an hour later and of course it is not, so a reply that had landed
        // perfectly well was reported as a network error until the page was
        // reloaded by hand.
        await pickTurnBackUp(controller, onEvent);
      } else {
        // Failing before it began means the message may never have been sent,
        // which is worth saying.
        await reload();
        setError(describeError(e, t, t("chat.errors.connectionFailed")));
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
    const updated = await data.messages.update(message.id, { active_index: index });
    setMessages((prev) => prev.map((m) => (m.id === message.id ? updated : m)));
  }

  async function edit(message: Message, content: string) {
    const updated = await data.messages.update(message.id, { content });
    setMessages((prev) => prev.map((m) => (m.id === message.id ? updated : m)));
  }

  async function deleteFrom(message: Message) {
    if (!confirm(t("chat.message.confirmDeleteFrom"))) return;
    await data.messages.removeFrom(message.id);
    setMessages((prev) => prev.filter((m) => m.position < message.position));
  }

  async function branchFrom(message: Message) {
    if (!confirm(t("chat.message.confirmBranch"))) return;
    const branch = await data.messages.branch(message.id);
    navigate(`/chat/${branch.id}`);
  }

  if (loadFailure) {
    return (
      <div className="p-10">
        <p className="text-blood">{describeError(loadFailure.error, t)}</p>
        <Link to="/chat" className="btn btn-ghost mt-4">
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
  // A lost connection is kept as the error itself and described here, so that
  // what reports it does not depend on the language.
  const problem = error ?? (connectionLost
    && describeError(connectionLost.error, t, t("chat.errors.connectionFailed")));
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
        <header className="flex items-center gap-3 border-b border-ink-700 bg-ink-900 px-4 py-3 pointer-coarse:py-[13px] md:bg-ink-900/80 md:backdrop-blur">
          <Link
            to="/chat"
            // 44px to hit on a touch screen, which the header does not grow for:
            // the button stands over its padding. The title below the name needs
            // 14px beyond it to be reached, hence 13px of padding there.
            className="rounded-lg p-1.5 text-mist transition-colors hover:bg-ink-800 hover:text-parchment pointer-coarse:-my-1 pointer-coarse:p-3"
            aria-label={t("chat.header.backAriaLabel")}
          >
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <Avatar name={character.name} src={character.avatar_url} className="h-9 w-9 text-base" />
          <div className="min-w-0">
            <h1 className="truncate font-display font-semibold leading-tight">{character.name}</h1>
            {titleDraft !== null ? (
              <input
                className="field !min-h-0 !w-64 !max-w-full !rounded-md !px-1.5 !py-0 text-xs"
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
                className="touch-target block w-full max-w-64 text-left text-xs text-mist transition-colors hover:text-parchment"
                onClick={() => setTitleDraft(conversation.title || "")}
                title={t("chat.header.renameTitle")}
              >
                {/* w-full above, so that the button is no wider than the box
                    it is in and the text, which does not wrap, is cut here:
                    a button that is wider spreads its area over what is next
                    to it. And the text is cut inside, because a button that
                    clips its text clips the area added to it for a touch
                    screen too. */}
                <span className="block truncate">
                  {conversation.title || t("chatList.newConversationFallback")}
                </span>
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
              className="rounded-lg p-2 text-mist transition-colors hover:bg-ink-800 hover:text-parchment pointer-coarse:-my-1 pointer-coarse:p-3 md:hidden"
              aria-label={t("chat.header.memorySettingsAriaLabel")}
            >
              <SlidersHorizontal className="h-5 w-5" />
            </button>
            {!panelOpen && (
              <button
                onClick={() => setPanelOpen(true)}
                className="hidden rounded-lg p-1.5 text-mist transition-colors hover:bg-ink-800 hover:text-parchment pointer-coarse:-my-1 pointer-coarse:p-3 md:block"
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

            {silent && (
              <div className="mx-1 my-3">
                <ModelSilent onRetry={() => runTurn("regenerate")} />
              </div>
            )}

            {problem && (
              <div className="mx-1 my-3 flex items-center justify-between gap-4 rounded-xl border border-blood/40 bg-blood/10 px-4 py-3">
                <p className="text-sm text-blood">{problem}</p>
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
