import { ChatInput } from "@/components/chat/ChatInput";
import { ChatMessage } from "@/components/chat/ChatMessage";
import { ModelSilent } from "@/components/chat/ModelSilent";
import { ChatSidePanel } from "@/components/chat/ChatSidePanel";
import { RpText } from "@/components/chat/RpText";
import { Avatar } from "@/components/ui/Avatar";
import { DataError, data, type TurnRequest } from "@/data";
import { useT } from "@/i18n/useT";
import { beginSending, forgetSending, settleSending, type MessageMode } from "@/lib/drafts";
import { describeError, describeEvent } from "@/lib/errors";
import { inTime, useTurn, type LiveText } from "@/lib/useTurn";
import type { Character, ContextStats, Conversation, Message, Persona, TurnFailure, TurnPerf } from "@/types";
import { ArrowLeft, PanelRightOpen, SlidersHorizontal } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { Link, useNavigate, useParams } from "react-router";

/** How many messages are drawn at first, and more each time more are asked for. */
const DRAWN = 100;

/** Keyed by the id, so that a branch, which opens at an address of its own,
 *  starts from its own messages rather than from the ones it was cut from. */
export function ChatPage() {
  const { id = "" } = useParams();
  return <ChatView key={id} id={id} />;
}

/** The reply being written: the only thing on screen that follows its words. */
function StreamBubble({ text, character, arriving, onGrow }: {
  text: LiveText;
  character: Character;
  arriving: boolean;
  onGrow: () => void;
}) {
  const t = useT();
  const words = useSyncExternalStore(text.subscribe, text.get);
  useEffect(onGrow, [words, onGrow]);
  return (
    <div className="flex gap-3.5 px-1 py-3">
      <Avatar name={character.name} src={character.avatar_url} className="mt-0.5 h-10 w-10 shrink-0 text-lg" />
      <div className="min-w-0 flex-1">
        <span className="font-display text-[0.95rem] font-semibold text-ember-300">{character.name}</span>
        <div className="mt-1">
          {words ? (
            <RpText text={words} streaming={arriving} />
          ) : (
            <span className="text-mist animate-pulse-soft italic">
              {t("chat.stream.assistantTyping", { name: character.name })}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function ChatView({ id }: { id: string }) {
  const t = useT();
  const navigate = useNavigate();
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [persona, setPersona] = useState<Persona | null>(null);
  const [panelOpen, setPanelOpen] = useState(true); // desktop, inline column
  // Phones: the panel covers the conversation, so a backdrop cannot be judged
  // from inside it. Adjusting closes the panel and leaves a bar over the real
  // thing instead.
  const [adjustingWallpaper, setAdjustingWallpaper] = useState(false);
  const opacityWrite = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [mobilePanelOpen, setMobilePanelOpen] = useState(false); // phone, overlay
  // Counts the times the story was cut back, for the side panel to read the facts again.
  const [storyCuts, setStoryCuts] = useState(0);
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  // Until the next thing is asked for. Not the reply's banner: its Retry asks for a reply.
  const [writeError, setWriteError] = useState<{ error: unknown } | null>(null);
  // What the server said no to, or could not be reached for, when a turn was last asked for.
  const [refused, setRefused] = useState<unknown>(null);
  const [drawn, setDrawn] = useState(DRAWN);
  // Counts what the person has done to the messages, so that a read sent before one of those
  // does not undo it.
  const changesByHand = useRef(0);

  /** A change made by hand, and whether the server took it. */
  async function write(change: () => Promise<unknown>) {
    setWriteError(null);
    try {
      await change();
      return true;
    } catch (error) {
      setWriteError({ error });
      return false;
    }
  }

  async function saveTitle() {
    if (titleDraft === null || !conversation) return;
    const title = titleDraft.trim();
    setTitleDraft(null);
    if (!title || title === conversation.title) return;
    if (await write(() => data.conversations.update(conversation.id, { title }))) {
      setConversation((c) => (c ? { ...c, title } : c));
    }
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
  const fromBottom = useRef<number | null>(null);

  // The title too, which the server gives a new conversation; the side panel reads the rest itself.
  const read = useCallback(async () => {
    const changes = changesByHand.current;
    const convo = await data.conversations.get(id);
    return () => {
      if (settleSending(id, convo.messages ?? [])) setRefused(null);
      if (changesByHand.current !== changes) return;
      setConversation((shown) => (shown ? { ...shown, title: convo.title } : convo));
      setMessages(convo.messages ?? []);
    };
  }, [id]);

  const { writing, text, lost, outcome, watch, began, recheck, forget } = useTurn(id, read);
  const busy = writing !== null;

  useEffect(() => {
    const personaId = conversation?.persona_id;
    if (!personaId) return;
    data.personas.list()
      .then((all) => setPersona(all.find((p) => p.id === personaId) ?? null))
      .catch(() => {});
  }, [conversation?.persona_id]);

  const followBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, []);
  useEffect(followBottom, [messages, writing, followBottom]);

  // Earlier messages come in above: the place being read stays where it was.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && fromBottom.current !== null) el.scrollTop = el.scrollHeight - fromBottom.current;
    fromBottom.current = null;
  }, [drawn]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }, []);

  /** Says whether the server has it. Whatever happened, the page then finds out how things stand. */
  async function ask(request: Omit<TurnRequest, "conversation_id">) {
    setRefused(null);
    setWriteError(null);
    forget();
    stickToBottom.current = true;
    try {
      const { user_message: sent } = await inTime(data.turns.start({ conversation_id: id, ...request }));
      if (sent) {
        setMessages((now) => [...now.filter((m) => m.id !== sent.id), sent].sort((a, b) => a.position - b.position));
      }
      began();
      return true;
    } catch (error) {
      setRefused(error);
      recheck();
      return false;
    }
  }

  async function sendMessage(content: string, messageMode: MessageMode) {
    const clientId = beginSending(id, content, messageMode);
    const sent = await ask({ mode: "send", content, message_mode: messageMode, client_id: clientId });
    if (sent) forgetSending(id, clientId);
    return sent;
  }

  /** The server answers once what arrived is saved. */
  async function stop() {
    setRefused(null);
    try {
      await inTime(data.turns.stop(id));
    } catch (error) {
      setRefused(error);
    }
    void watch();
  }

  const last = messages.at(-1);
  // What the person's last message says of its reply, if it has none: `true`, or why.
  const unanswered = !busy && last?.role === "user" ? last.meta?.unanswered : undefined;
  const failure: TurnFailure | null = busy
    ? null
    : (outcome ?? (typeof unanswered === "object" && unanswered !== null ? (unanswered as TurnFailure) : null));

  /** The reply that failed, asked for again: a message that did not go is sent again with Send. */
  function retry() {
    return ask({ mode: outcome?.mode === "continue" ? "continue" : "regenerate" });
  }

  async function swipe(message: Message, index: number) {
    const updated = await data.messages.update(message.id, { active_index: index });
    changesByHand.current += 1;
    setMessages((prev) => prev.map((m) => (m.id === message.id ? updated : m)));
  }

  async function edit(message: Message, content: string) {
    const updated = await data.messages.update(message.id, { content });
    changesByHand.current += 1;
    setMessages((prev) => prev.map((m) => (m.id === message.id ? updated : m)));
  }

  /** The server ends a reply being written before it cuts the story. */
  async function deleteFrom(message: Message) {
    if (!confirm(t("chat.message.confirmDeleteFrom"))) return;
    await data.messages.removeFrom(message.id);
    changesByHand.current += 1;
    setMessages((prev) => prev.filter((m) => m.position < message.position));
    // The server takes the memory back with the story; the panel reads it again.
    setStoryCuts((n) => n + 1);
    // Whatever was being reported was about what has just gone.
    setRefused(null);
    forget();
  }

  async function branchFrom(message: Message) {
    if (!confirm(t("chat.message.confirmBranch"))) return;
    const branch = await data.messages.branch(message.id);
    navigate(`/chat/${branch.id}`);
  }

  function showEarlier() {
    const el = scrollRef.current;
    fromBottom.current = el ? el.scrollHeight - el.scrollTop : null;
    setDrawn((n) => n + DRAWN);
  }

  if (lost && !conversation) {
    return (
      <div className="p-10">
        <p className="text-blood">{describeError(lost, t)}</p>
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
  // A model that never answered is not a fault to raise the alarm about; usually
  // the server behind it is simply not running.
  const silent = failure?.kind === "unreachable";
  // That another reply is being written, only as long as it is.
  const refusal = refused instanceof DataError && refused.kind === "turn_running" && !busy ? null : refused;
  const problem = lost || refusal
    ? describeError(lost || refusal, t, t("chat.errors.connectionFailed"))
    : failure?.kind === "nothing_added"
      ? t("chat.errors.nothingAdded")
      : failure && !silent
        ? describeEvent(failure, t)
        : unanswered === true
          ? t("chat.errors.noReply")
          : null;
  const latest = messages.findLast((m) => m.meta?.context)?.meta;
  const contextStats = latest?.context as ContextStats | undefined;
  const perf = latest?.perf as TurnPerf | undefined;
  // The message being written is drawn from its words as they arrive.
  const visibleMessages = messages.filter((m) => m.id !== writing);
  const drawnMessages = visibleMessages.slice(-drawn);

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
            {drawnMessages.length < visibleMessages.length && (
              <button className="btn btn-ghost mx-auto mb-2 block text-xs" onClick={showEarlier}>
                {t("chat.showEarlier")}
              </button>
            )}
            {drawnMessages.map((message) => (
              <ChatMessage
                key={message.id}
                message={message}
                character={character}
                persona={persona}
                isLast={message.id === last?.id}
                busy={busy}
                onSwipe={(index) => write(() => swipe(message, index))}
                onRegenerate={() => ask({ mode: "regenerate" })}
                onContinue={() => ask({ mode: "continue" })}
                onEdit={(content) => write(() => edit(message, content))}
                onDeleteFrom={() => write(() => deleteFrom(message))}
                onBranch={() => write(() => branchFrom(message))}
              />
            ))}

            {busy && <StreamBubble text={text} character={character} arriving={!lost} onGrow={followBottom} />}

            {silent && (
              <div className="mx-1 my-3">
                <ModelSilent onRetry={retry} />
              </div>
            )}

            {problem && (
              <div className="mx-1 my-3 flex items-center justify-between gap-4 rounded-xl border border-blood/40 bg-blood/10 px-4 py-3">
                <p className="text-sm text-blood">{problem}</p>
                {!busy && !lost && !refusal && (
                  <button className="btn btn-ghost shrink-0 !py-1.5 text-xs" onClick={retry}>
                    {t("chat.errors.retryButton")}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Out of the scrolling: what failed may be far above, or in the header. */}
        {writeError && (
          <p role="alert" className="border-t border-ink-700 bg-ink-900 px-4 py-2 text-center text-sm text-blood">
            {describeError(writeError.error, t)}
          </p>
        )}
        <ChatInput
          conversationId={conversation.id}
          onSend={sendMessage}
          onStop={stop}
          busy={busy && !lost}
          characterName={character.name}
        />
      </div>

      {/* Desktop: inline right column */}
      {panelOpen && (
        <ChatSidePanel
          conversation={conversation}
          persona={persona}
          storyCuts={storyCuts}
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
            storyCuts={storyCuts}
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
