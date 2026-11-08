import { ChatInput } from "@/components/chat/ChatInput";
import { ChatMessage } from "@/components/chat/ChatMessage";
import { ModelSilent } from "@/components/chat/ModelSilent";
import { ChatSidePanel } from "@/components/chat/ChatSidePanel";
import { RpText } from "@/components/chat/RpText";
import { Avatar } from "@/components/ui/Avatar";
import { DataError, data, type Asking, type TurnRequest } from "@/data";
import { useT } from "@/i18n/useT";
import { beginSending, type MessageMode } from "@/lib/drafts";
import { describeError, describeFailure, isUnanswered } from "@/lib/errors";
import { PATIENCE_MS, useTurn, type LiveText } from "@/lib/useTurn";
import type { Character, ContextStats, Conversation, Message, Persona, TurnFailure, TurnPerf } from "@/types";
import { ArrowLeft, SlidersHorizontal } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { Link, useNavigate, useParams } from "react-router";

/** How many messages are drawn at first, and more each time more are asked for. */
const DRAWN = 100;
/** Tailwind's `md`, from which the side panel sits beside the conversation rather than over it. */
const WIDE = "(min-width: 48rem)";

/** Keyed by the id, so that a branch starts from its own messages, not from those it was cut from. */
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
  // Over the conversation on a phone, so open there only once asked for, and closed if the screen narrows.
  const [panelOpen, setPanelOpen] = useState(() => window.matchMedia(WIDE).matches);
  useEffect(() => {
    const wide = window.matchMedia(WIDE);
    const narrowed = () => {
      if (!wide.matches) setPanelOpen(false);
    };
    wide.addEventListener("change", narrowed);
    return () => wide.removeEventListener("change", narrowed);
  }, []);
  // The backdrop's strength is set under the conversation, where it can be judged.
  const [adjustingWallpaper, setAdjustingWallpaper] = useState(false);
  const opacityWrite = useRef<ReturnType<typeof setTimeout> | null>(null);
  const opacityHeld = useRef<number | undefined>(undefined); // what the server holds
  // Counts the times the server took the memory back, for the side panel to read it again.
  const [storyCuts, setStoryCuts] = useState(0);
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  // Until the next thing is asked for. Not the reply's banner: its Retry asks for a reply.
  const [writeError, setWriteError] = useState<{ error: unknown } | null>(null);
  const [drawn, setDrawn] = useState(DRAWN);
  // Counts what the person has done to the messages, so that a read sent before one of those
  // does not undo it.
  const changesByHand = useRef(0);

  /** A change made by hand, and whether the server took it. One whose answer was lost, or that
   *  found its message gone, may have been made all the same: given `landed`, told the messages the
   *  server holds, the conversation is read and shown, and nothing said unless that read fails too. */
  async function write(change: () => Promise<unknown>, landed?: (messages: Message[]) => void) {
    setWriteError(null);
    try {
      await change();
      return true;
    } catch (error) {
      if (landed && (isUnanswered(error) || (error instanceof DataError && error.kind === "not_found"))) {
        changesByHand.current += 1; // a read sent before this one does not undo it
        const now = await read({ within: PATIENCE_MS }).then(
          ({ conversation, show }) => (show() ? conversation.messages ?? [] : null),
          () => null,
        );
        if (now) {
          landed(now);
          return false;
        }
      }
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

  /** Live on every pixel of the drag, written once it settles. One the server does not take
   *  goes back to what it holds, unless moved since. */
  function setWallpaperOpacity(value: number) {
    opacityHeld.current ??= conversation?.wallpaper_opacity;
    setConversation((c) => (c ? { ...c, wallpaper_opacity: value } : c));
    if (opacityWrite.current) clearTimeout(opacityWrite.current);
    opacityWrite.current = setTimeout(async () => {
      if (await write(() => data.conversations.update(id, { wallpaper_opacity: value }))) {
        opacityHeld.current = value;
      } else {
        const held = opacityHeld.current;
        setConversation((c) => (c?.wallpaper_opacity === value ? { ...c, wallpaper_opacity: held } : c));
      }
    }, 350);
  }

  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const fromBottom = useRef<number | null>(null);

  // Counts the reads of the summary a closed panel opens on, and the summaries the panel shows.
  const summaries = useRef(0);
  const panelShown = useRef(panelOpen);
  useEffect(() => {
    panelShown.current = panelOpen;
  }, [panelOpen]);
  /** For a read about to be sent: what takes its summary, unless another came since. */
  const summaryTaker = useCallback(() => {
    // Sent with the panel open, it is left to the panel, whose own reads it knows nothing of.
    const sent = panelShown.current ? null : ++summaries.current;
    return (summary: string) => {
      if (sent === summaries.current) setConversation((c) => (c ? { ...c, summary } : c));
    };
  }, []);

  // The messages, the title, which the server gives a new conversation, and the summary for a closed panel.
  const read = useCallback(async (asking: Asking) => {
    const changes = changesByHand.current;
    const takeSummary = summaryTaker();
    const conversation = await data.conversations.get(id, asking);
    const show = () => {
      if (changesByHand.current !== changes) return false;
      takeSummary(conversation.summary);
      setConversation((shown) => (shown ? { ...shown, title: conversation.title } : conversation));
      setMessages(conversation.messages ?? []);
      return true;
    };
    return { conversation, show };
  }, [id, summaryTaker]);

  // The person's message as the server saved it, before the conversation is read again.
  const add = useCallback((sent: Message) => {
    setMessages((now) => [...now.filter((m) => m.id !== sent.id), sent].sort((a, b) => a.position - b.position));
  }, []);

  const turn = useTurn(id, read, add);
  const { writing, text, lost, outcome, refused, stop, forget } = turn;
  const busy = writing !== null;

  // A closed panel reads nothing, and no read follows a cut or a swipe: the summary is read here then.
  const summaryRead = useRef<AbortController | null>(null);
  useEffect(() => () => summaryRead.current?.abort(), []);
  /** The server took the memory back: an open panel reads it again. */
  const memoryTakenBack = useCallback(() => {
    setStoryCuts((n) => n + 1);
    if (panelShown.current) return;
    summaryRead.current?.abort();
    const reading = (summaryRead.current = new AbortController());
    const takeSummary = summaryTaker();
    data.conversations.get(id, { signal: reading.signal }).then(({ summary }) => takeSummary(summary), () => {});
  }, [id, summaryTaker]);

  // A reply asked for again or carried on takes back a memory that read it: an open panel reads it at the turn's end.
  const rewriting = useRef(false);
  const wasWriting = useRef(writing);
  useEffect(() => {
    if (wasWriting.current !== null && writing === null && rewriting.current) {
      rewriting.current = false;
      setStoryCuts((n) => n + 1);
    }
    wasWriting.current = writing;
  }, [writing]);

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

  /** Settles at the server's answer or at patience's end; either way the page then finds out how things stand. */
  function ask(request: Omit<TurnRequest, "conversation_id">) {
    setWriteError(null);
    stickToBottom.current = true;
    if (request.mode !== "send") rewriting.current = true;
    return turn.ask(request);
  }

  function sendMessage(content: string, messageMode: MessageMode) {
    const clientId = beginSending(id, content, messageMode);
    return ask({ mode: "send", content, message_mode: messageMode, client_id: clientId });
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
    swiped(message, updated);
  }

  /** Other words for the newest reply take back a memory that read it. */
  function swiped(message: Message, now: Message | undefined) {
    if (message.id === last?.id && now && now.active_index !== message.active_index) memoryTakenBack();
  }

  async function edit(message: Message, content: string, index: number) {
    const updated = await data.messages.update(message.id, { content, active_index: index });
    changesByHand.current += 1;
    setMessages((prev) => prev.map((m) => (m.id === message.id ? updated : m)));
  }

  /** The server ends a reply being written before it cuts the story. */
  async function deleteFrom(message: Message) {
    if (!confirm(t("chat.message.confirmDeleteFrom"))) return;
    await data.messages.removeFrom(message.id);
    changesByHand.current += 1;
    setMessages((prev) => prev.filter((m) => m.position < message.position));
    cut();
  }

  function cut() {
    // The server takes the memory back with the story.
    memoryTakenBack();
    // Whatever was being reported was about what has just gone.
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
  const strength = Math.round((conversation.wallpaper_opacity ?? 0.25) * 100);
  const silent = failure?.kind === "unreachable";
  // That another reply is being written, only as long as it is.
  const refusal = refused instanceof DataError && refused.kind === "turn_running" && !busy ? null : refused;
  const problem = lost || refusal
    ? describeError(lost || refusal, t, t("chat.errors.connectionFailed"))
    : failure?.kind === "nothing_added"
      ? t("chat.errors.nothingAdded")
      : failure && !silent
        ? describeFailure(failure, t)
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
        <header className="flex items-center gap-3 border-b border-ink-700 bg-ink-900 px-4 py-3 pointer-coarse:py-[13px] md:bg-ink-900/80 md:backdrop-blur">
          <Link
            to="/chat"
            // 44px on a touch screen, over the header's padding; the title below the name needs 14px beyond it, hence 13px there.
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
                {/* No wider than its box (w-full above), with the text cut inside: a wider button spreads its
                    area over what is next to it, and one that clips its text clips its touch area too. */}
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
            {!panelOpen && (
              <button
                onClick={() => setPanelOpen(true)}
                className="rounded-lg p-2 text-mist transition-colors hover:bg-ink-800 hover:text-parchment pointer-coarse:-my-1 pointer-coarse:p-3"
                aria-label={t("chat.header.memorySettingsAriaLabel")}
              >
                <SlidersHorizontal className="h-5 w-5" />
              </button>
            )}
          </div>
        </header>

        <div ref={scrollRef} onScroll={onScroll} className="relative flex-1 overflow-y-auto">
          {conversation.wallpaper_url && (
            // Pinned to the column: a backdrop that scrolls with the text is a picture in the conversation, not behind it.
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
                onSwipe={(index) => write(() => swipe(message, index),
                  (now) => swiped(message, now.find((m) => m.id === message.id)))}
                onRegenerate={() => ask({ mode: "regenerate" })}
                onContinue={() => ask({ mode: "continue" })}
                onEdit={(content, index) => write(() => edit(message, content, index))}
                onDeleteFrom={() => write(() => deleteFrom(message), (now) => {
                  if (!now.some((m) => m.id === message.id)) cut();
                })}
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
        {adjustingWallpaper && conversation.wallpaper_url && (
          <div className="border-t border-ink-700 bg-ink-900 px-4 py-3">
            <div className="mx-auto max-w-3xl">
              <div className="mb-2 flex items-center justify-between text-sm">
                <span className="text-mist">{t("chat.wallpaper.opacity")}</span>
                <span className="tabular-nums text-parchment-dim">{strength}%</span>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                value={strength}
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
          </div>
        )}
        <ChatInput
          conversationId={conversation.id}
          onSend={sendMessage}
          onStop={stop}
          busy={busy && !lost}
          characterName={character.name}
        />
      </div>

      {panelOpen && (
        <ChatSidePanel
          conversation={conversation}
          persona={persona}
          storyCuts={storyCuts}
          onClose={() => setPanelOpen(false)}
          onConversationChange={(patch) => {
            if ("summary" in patch) summaries.current += 1;
            setConversation((c) => (c ? { ...c, ...patch } : c));
          }}
          onAdjustWallpaper={() => {
            // Over the conversation, it would hide what is being judged.
            if (!window.matchMedia(WIDE).matches) setPanelOpen(false);
            setAdjustingWallpaper(true);
          }}
        />
      )}
    </div>
  );
}
