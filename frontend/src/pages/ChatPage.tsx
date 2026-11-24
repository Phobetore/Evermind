import { AddAiFlow } from "@/components/ai/AddAiFlow";
import { AiChip, AiSheet } from "@/components/chat/AiSheet";
import { Backdrop } from "@/components/chat/Backdrop";
import { CardSummary } from "@/components/chat/CardSummary";
import { ChatInput } from "@/components/chat/ChatInput";
import { ChatMessage } from "@/components/chat/ChatMessage";
import { ModelSilent } from "@/components/chat/ModelSilent";
import { ChatSidePanel } from "@/components/chat/ChatSidePanel";
import { ChatStatusRow } from "@/components/chat/ChatStatusRow";
import { useChatToast } from "@/components/chat/ChatToast";
import { RpText } from "@/components/chat/RpText";
import { useConversationBackdrop } from "@/components/chat/useConversationBackdrop";
import { DisplayControls } from "@/components/display/DisplayControls";
import { Avatar } from "@/components/ui/Avatar";
import { PageWait } from "@/components/ui/PageWait";
import { Sheet } from "@/components/ui/Sheet";
import { DataError, data, type AiSaved, type Asking, type TurnRequest } from "@/data";
import { useT } from "@/i18n/useT";
import { answering, roomFor } from "@/lib/ai";
import { backdropOf, plateAlpha, useDisplay } from "@/lib/display";
import { beginSending, type MessageMode } from "@/lib/drafts";
import { describeCeiling } from "@/lib/cutShort";
import { describeError, describeFailure, isUnanswered } from "@/lib/errors";
import { memoryFailed } from "@/lib/memoryMark";
import { holdSizes, wantSizes } from "@/lib/portraitSizes";
import { PATIENCE_MS, useTurn, type LiveText } from "@/lib/useTurn";
import { hasKeyboard, newId, nothingFocused, smallPortrait } from "@/lib/utils";
import { clsx } from "clsx";
import type { Ai, Character, ContextStats, Conversation, Message, Persona, TurnFailure, TurnPerf } from "@/types";
import { ArrowLeft, SlidersHorizontal } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { Link, useNavigate, useParams } from "react-router";

/** How many messages are drawn at first, and more each time more are asked for. */
const DRAWN = 100;
/** Tailwind's `md`, from which the side panel sits beside the conversation rather than over it. */
const WIDE = "(min-width: 48rem)";
/** From which it opens there by default: narrower, beside the sidebar, it leaves the story a sliver. */
const ROOMY = "(min-width: 64rem)";

/** The header's icon buttons: 44px squares at any width and any size of the system's text. */
const headerSquare =
  "inline-flex size-[44px] shrink-0 items-center justify-center rounded-lg text-mist transition-colors hover:bg-ink-800 hover:text-parchment pointer-coarse:-my-1";

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
      <Avatar name={character.name} src={smallPortrait(character)} className="mt-0.5 size-[40px] shrink-0 text-lg" />
      <div className="msg-body min-w-0 flex-1">
        <span className="chat-name font-display font-semibold text-ember-300">{character.name}</span>
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
  const [showCard, setShowCard] = useState(false);
  // Over the conversation on a phone, so open there only once asked for, and closed if the screen narrows.
  const [wide, setWide] = useState(() => window.matchMedia(WIDE).matches);
  const [panelOpen, setPanelOpen] = useState(() => window.matchMedia(ROOMY).matches);
  // Opened or closed by hand, the panel takes the focus, and gives it back to what opens it.
  const [panelByHand, setPanelByHand] = useState(false);
  useEffect(() => {
    const query = window.matchMedia(WIDE);
    const changed = () => {
      setWide(query.matches);
      if (query.matches) return;
      setPanelOpen(false);
      setPanelByHand(false); // not by hand: the focus stays where it is, in a sentence being typed say
    };
    query.addEventListener("change", changed);
    return () => query.removeEventListener("change", changed);
  }, []);
  function showPanel(open: boolean) {
    setPanelByHand(true);
    setPanelOpen(open);
  }
  const panelButton = useRef<HTMLButtonElement>(null);
  // The Display sheet, over the conversation it changes: where the focus goes back to once it
  // closes, if what opened it has gone (the panel closes under it on a phone).
  const [displaySheet, setDisplaySheet] = useState<{ focusStrength: boolean; returnTo: () => HTMLElement | null } | null>(null);
  const displayButton = useRef<HTMLButtonElement>(null);
  const display = useDisplay();
  // Counts the times the server took the memory back, for the side panel to read it again.
  const [storyCuts, setStoryCuts] = useState(0);
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  // Renamed or not, the keyboard is left on the title rather than on the page.
  const titleButton = useRef<HTMLButtonElement>(null);
  const renaming = useRef(false);
  useEffect(() => {
    if (renaming.current && titleDraft === null && nothingFocused()) titleButton.current?.focus();
    renaming.current = titleDraft !== null;
  }, [titleDraft]);
  // Until the next thing is asked for. Not the reply's banner: its Retry asks for a reply.
  const [writeError, setWriteError] = useState<{ error: unknown } | null>(null);
  const [drawn, setDrawn] = useState(DRAWN);
  // Counts what the person has done to the messages, so that a read sent before one of those
  // does not undo it.
  const changesByHand = useRef(0);
  // The AIs, read once with the page, where the edition keeps its own; null until they are.
  const [ais, setAis] = useState<Ai[] | null>(null);
  // The room a reply needs, from the settings read once with the page: 0 until then, warning of nothing.
  const [room, setRoom] = useState(0);
  const [aiSheet, setAiSheet] = useState(false);
  const [addingAi, setAddingAi] = useState(false);
  const { toast, node: toastNode } = useChatToast();
  useEffect(() => {
    // Caught: offline it rejects, and an unhandled rejection is noise in the console.
    data.connections?.models.list().then(setAis, () => {});
    data.settings.get().then((settings) => setRoom(roomFor(settings)), () => {});
  }, []);

  /** Whether the server took a change; given `landed`, a lost answer or a message gone shows what it holds. */
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

  const backdrop = useConversationBackdrop(conversation, setConversation);
  function openDisplay(focusStrength: boolean, returnTo: () => HTMLElement | null) {
    // Only what the sheet itself writes is said in it, and only from now on.
    backdrop.forget();
    setDisplaySheet({ focusStrength, returnTo });
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
  /** For a read about to be sent: what takes its summary, and whether the last pass of the memory
   *  failed, which the header marks, unless another read came since. */
  const summaryTaker = useCallback(() => {
    // Sent with the panel open, it is left to the panel, whose own reads it knows nothing of.
    const sent = panelShown.current ? null : ++summaries.current;
    return ({ summary, memory_error = null }: Pick<Conversation, "summary" | "memory_error">) => {
      if (sent === summaries.current) setConversation((c) => (c ? { ...c, summary, memory_error } : c));
    };
  }, []);

  // The messages, the title, which the server gives a new conversation, and the summary for a closed panel.
  const read = useCallback(async (asking: Asking) => {
    const changes = changesByHand.current;
    const takeSummary = summaryTaker();
    const conversation = await data.conversations.get(id, asking);
    const show = () => {
      if (changesByHand.current !== changes) return false;
      takeSummary(conversation);
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

  // A reply asked for again or carried on takes back a memory that read it: an open panel reads it at
  // the turn's end, once the page shows the story with nothing being written. That is also when the
  // request's answer was lost and the page found the turn already over, never having seen it run.
  const rewriting = useRef(false);
  const settled = useCallback(() => {
    if (!rewriting.current) return;
    rewriting.current = false;
    setStoryCuts((n) => n + 1);
  }, []);

  const turn = useTurn(id, read, add, settled);
  const { writing, text, lost, outcome, refused, stop, forget } = turn;
  const busy = writing !== null;

  // A reply redone by the AI just chosen, said once it is in: not when it failed or was refused.
  const redoing = useRef<string | null>(null);
  const wasBusy = useRef(false);
  useEffect(() => {
    if (busy) {
      wasBusy.current = true;
      return;
    }
    if (refused) redoing.current = null;
    if (!wasBusy.current) return;
    wasBusy.current = false;
    const name = redoing.current;
    redoing.current = null;
    if (name !== null && !outcome && !lost) toast(t("chat.ai.redone", { name }));
  }, [busy, outcome, lost, refused, toast, t]);

  // The home's link belongs to the reply while it is written: a portrait's copies wait for its end.
  useEffect(() => holdSizes(busy), [busy]);
  useEffect(() => () => holdSizes(false), []);
  // A portrait from before its copies existed, or whose copies no device has made yet.
  const pictured = conversation?.character ?? null;
  useEffect(() => {
    if (pictured) wantSizes(pictured);
  }, [pictured]);

  // A screen reader hears nothing of the words arriving: it is told a reply is being written, then that it is in.
  // A reply the connection's max tokens cut is told so with it, once: the line under it is not live.
  const [heard, setHeard] = useState<{ writing: string | null; said: "" | "typing" | "replied"; cut: string | null }>(
    { writing, said: "", cut: null });
  if (heard.writing !== writing) {
    const said = writing !== null ? "typing" : heard.said && !outcome ? "replied" : "";
    const newest = messages.at(-1);
    const cut = said === "replied" && newest?.role === "assistant" ? describeCeiling(newest, t) : null;
    setHeard({ writing, said, cut });
  }

  // The focus a reply's button lost goes to Stop, then to the reply, leaving the story where it is read.
  const stopButton = useRef<HTMLButtonElement>(null);
  const replyButton = useRef<HTMLButtonElement>(null);
  const keepFocus = useRef(false);
  useEffect(() => {
    if (keepFocus.current && nothingFocused()) {
      (busy ? stopButton : replyButton).current?.focus({ preventScroll: true });
    }
    if (!busy) keepFocus.current = false;
  }, [busy]);

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
    data.conversations.withoutMessages(id, { signal: reading.signal }).then(takeSummary, () => {});
  }, [id, summaryTaker]);

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

  // The message being read: the first whose bottom is below the top of the story, and how far
  // above that top its own top is, as a share of its height.
  const reading = useRef<{ id: string; share: number } | null>(null);
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    const top = el.getBoundingClientRect().top;
    for (const message of el.querySelectorAll<HTMLElement>("[data-message-id]")) {
      const box = message.getBoundingClientRect();
      if (box.bottom <= top) continue;
      reading.current = { id: message.dataset.messageId!, share: box.height ? (top - box.top) / box.height : 0 };
      return;
    }
    reading.current = null;
  }, []);

  /** Puts the place being read back where it was once the text has flowed again, before it is
   *  painted. The browser's own anchoring is off on the story: Chrome's would move the view, and its
   *  scroll event would unstick the bottom while a reply is being written; Safari has none at all. */
  const keepPlace = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (stickToBottom.current) {
      el.scrollTop = el.scrollHeight;
      return;
    }
    const place = reading.current;
    const message = place && el.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(place.id)}"]`);
    if (!place || !message) return;
    const box = message.getBoundingClientRect();
    el.scrollTop += box.top + place.share * box.height - el.getBoundingClientRect().top;
  }, []);
  useLayoutEffect(keepPlace, [display.text, keepPlace]);
  // The text flows again when the story's width changes too: the panel opened or closed beside it,
  // a phone turned. Not its height alone, the keyboard opening, which moves nothing at the top.
  // Called after layout, before paint.
  const [storyNode, setStoryNode] = useState<HTMLDivElement | null>(null);
  const storyRef = useCallback((node: HTMLDivElement | null) => {
    scrollRef.current = node;
    setStoryNode(node);
  }, []);
  useEffect(() => {
    if (!storyNode) return;
    let width = storyNode.clientWidth;
    const watch = new ResizeObserver(() => {
      if (storyNode.clientWidth === width) return;
      width = storyNode.clientWidth;
      keepPlace();
    });
    watch.observe(storyNode);
    return () => watch.disconnect();
  }, [storyNode, keepPlace]);

  /** Settles at the server's answer or at patience's end; either way the page then finds out how things stand. */
  function ask(request: Omit<TurnRequest, "conversation_id">) {
    keepFocus.current = true;
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

  // Each message's branch keeps its id, so that one asked for again after its answer was lost is the one made.
  const branchIds = useRef(new Map<string, string>());
  async function branchFrom(message: Message) {
    const clientId = branchIds.current.get(message.id) ?? newId();
    branchIds.current.set(message.id, clientId);
    const branch = await data.messages.branch(message.id, clientId);
    navigate(`/chat/${branch.id}`);
  }

  function showEarlier() {
    const el = scrollRef.current;
    fromBottom.current = el ? el.scrollHeight - el.scrollTop : null;
    setDrawn((n) => n + DRAWN);
  }

  /** The AI answering from now on, as the server took it; the last reply can be redone by it while
   *  nothing is being written, the reply before kept beside it. */
  function switched(ai: Ai) {
    setAiSheet(false);
    // Another AI chosen: the line saying one was removed goes with it, as on the server.
    setConversation((c) => (c ? { ...c, model_id: ai.id, model_lost: null } : c));
    const newest = messages.at(-1);
    const redoable = !busy && newest?.role === "assistant" && !newest.meta?.greeting;
    toast(t("chat.ai.switched", { name: ai.name }), redoable
      ? {
          label: t("chat.ai.redo"),
          run: () => {
            redoing.current = ai.name;
            void ask({ mode: "regenerate" });
          },
        }
      : undefined);
  }

  /** An AI as the server saved it, in the list the page holds. */
  function tookAi(saved: AiSaved) {
    setAis((now) => now && now.map((ai) => (ai.id === saved.id ? saved : ai)));
  }

  /** The ceiling of its own the AI answering keeps, lifted: a setting of the AI's. */
  async function letEvermind(ai: Ai) {
    try {
      const saved = await data.connections!.models.update(ai.id, { reply_cap: { mode: "auto" } });
      tookAi(saved);
      toast(t("ai.notice.capLifted", { name: saved.name }));
    } catch (error) {
      toast(describeError(error, t));
    }
  }

  async function seeLost() {
    if (await write(() => data.conversations.update(id, { model_lost_seen: true }))) {
      setConversation((c) => (c ? { ...c, model_lost: null } : c));
    }
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
    return <PageWait words={t("chat.openingScene")} />;
  }

  const character = conversation.character;
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
  const shown = backdropOf(conversation, character, display);
  // The plate under the text, only where a picture is drawn: with none, nothing changes.
  const veiled = shown.src !== null && shown.strength > 0;
  const drawnMessages = visibleMessages.slice(-drawn);
  // What answers it, where the edition keeps AIs of its own; drawn once they are read.
  const chipShown = data.connections !== undefined && ais !== null;
  const answeringAi = ais ? answering(conversation.model_id, ais) : null;
  const lostLine = chipShown && conversation.model_lost && (
    <div
      data-model-lost
      className="mx-auto mb-2.5 flex max-w-3xl flex-wrap items-center justify-center gap-x-3 gap-y-1 text-center text-xs text-parchment-dim"
    >
      <span className="min-w-0 [overflow-wrap:anywhere]">
        {answeringAi
          ? t("chat.ai.lost", { lost: conversation.model_lost, name: answeringAi.name })
          : t("chat.ai.lostNone", { lost: conversation.model_lost })}
      </span>
      <button type="button" className="btn btn-ghost touch-target !py-1 text-xs" onClick={seeLost}>
        {t("chat.ai.seen")}
      </button>
    </div>
  );

  return (
    <div className="flex h-full">
      {/* Under the panel, which covers it below md, out of the keyboard's reach. */}
      {/* The scale of the story's text, here only: the panel and the card beside it keep theirs. A
          container, for the header to make room under 320px, in px like its buttons. */}
      <div
        className="@container/column flex min-w-0 flex-1 flex-col"
        inert={panelOpen && !wide}
        style={{ "--chat-scale": display.text } as React.CSSProperties}
      >
        {/* Its widths in px, which the system's text size leaves alone: under a root of 32px, buttons in
            rem would leave the name nothing. Only the name and the title follow that size. Under 320px the
            portrait goes (the panel opens the card in short then) and the gaps and sides narrow. */}
        <header className="flex items-center gap-[12px] border-b border-ink-700 bg-ink-900 px-[16px] py-3 pointer-coarse:py-[13px] md:bg-ink-900/80 md:backdrop-blur @max-[320px]/column:gap-[4px] @max-[320px]/column:px-[8px]">
          <Link
            to="/chat"
            // Over the header's padding on a touch screen; the title below the name needs 14px beyond it, hence 13px there.
            className={headerSquare}
            aria-label={t("chat.header.backAriaLabel")}
          >
            <ArrowLeft className="size-[20px]" />
          </Link>
          {/* The avatar opens the card in short, as in a messaging app. Not the name too: stacked over
              the title, a second 44px area would take the title's touches. */}
          <button
            onClick={() => setShowCard(true)}
            className="inline-flex size-[44px] shrink-0 items-center justify-center rounded-lg transition-opacity hover:opacity-80 pointer-coarse:-my-1 @max-[320px]/column:hidden"
            aria-label={t("chat.cardSummary.aboutAriaLabel", { name: character.name })}
            title={t("chat.cardSummary.aboutAriaLabel", { name: character.name })}
            aria-haspopup="dialog"
          >
            <Avatar name={character.name} src={smallPortrait(character)} className="size-[36px] text-base" />
          </button>
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
                  // Or the same press would open the title again, focused once it is back.
                  if (e.key === "Enter") {
                    e.preventDefault();
                    saveTitle();
                  }
                  if (e.key === "Escape") setTitleDraft(null);
                }}
              />
            ) : (
              <button
                ref={titleButton}
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
          <div className="ml-auto flex items-center gap-[12px] @max-[320px]/column:gap-[4px]">
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
              ref={displayButton}
              onClick={() => openDisplay(false, () => displayButton.current)}
              className={headerSquare}
              aria-label={t("chat.header.displayAriaLabel")}
              title={t("chat.header.displayAriaLabel")}
              aria-haspopup="dialog"
            >
              {/* As wide and tall as the icon of the button beside it. */}
              <span aria-hidden className="block h-[20px] min-w-[20px] font-display text-[16px] leading-[20px]">Aa</span>
            </button>
            {!panelOpen && (
              <button
                ref={panelButton}
                autoFocus={panelByHand}
                onClick={() => showPanel(true)}
                className={clsx(headerSquare, "relative")}
                aria-label={t("chat.header.memorySettingsAriaLabel")}
                // Heard with the button: a button's name is its label alone, and its content is not read.
                aria-describedby={memoryFailed(conversation) ? "memory-mark" : undefined}
                title={memoryFailed(conversation) ? t("memoryMark.label") : undefined}
              >
                <SlidersHorizontal className="size-[20px]" />
                {/* Over the icon's corner, taking no room: the header neither grows nor wraps for it. */}
                {memoryFailed(conversation) && (
                  <span
                    id="memory-mark"
                    role="img"
                    aria-label={t("memoryMark.label")}
                    className="absolute right-[8px] top-[8px] size-[8px] rounded-full bg-blood"
                  />
                )}
              </button>
            )}
          </div>
        </header>

        {/* The picture takes the story's box exactly, under the part that scrolls: it stays put while
            the text moves, and follows the column as the keyboard opens or the panel takes a share. */}
        <div className="relative min-h-0 flex-1">
          <Backdrop shown={shown} />
          <div
            ref={storyRef}
            data-story
            onScroll={onScroll}
            className={clsx("absolute inset-0 overflow-y-auto [overflow-anchor:none]", veiled && "over-backdrop")}
            style={veiled ? ({ "--plate": plateAlpha(shown.strength) } as React.CSSProperties) : undefined}
          >
            <div className="mx-auto max-w-3xl px-4 py-6">
              {drawnMessages.length < visibleMessages.length && (
                <div className="chat-surface mx-auto mb-2 w-fit">
                  <button className="btn btn-ghost block text-xs" onClick={showEarlier}>
                    {t("chat.showEarlier")}
                  </button>
                </div>
              )}
              {drawnMessages.map((message) => (
                <ChatMessage
                  key={message.id}
                  message={message}
                  character={character}
                  persona={persona}
                  isLast={message.id === last?.id}
                  busy={busy}
                  replyRef={message.id === last?.id ? replyButton : undefined}
                  onSwipe={(index) => write(() => swipe(message, index),
                    (now) => swiped(message, now.find((m) => m.id === message.id)))}
                  onRegenerate={() => ask({ mode: "regenerate" })}
                  onContinue={() => ask({ mode: "continue" })}
                  onEdit={(content, index) => write(() => edit(message, content, index))}
                  onDeleteFrom={() => write(() => deleteFrom(message), (now) => {
                    if (!now.some((m) => m.id === message.id)) cut();
                  })}
                  onBranch={() => write(() => branchFrom(message))}
                  onLetEvermind={message.id === last?.id && answeringAi?.reply_cap.mode === "fixed"
                    ? () => letEvermind(answeringAi)
                    : undefined}
                />
              ))}

              {busy && <StreamBubble text={text} character={character} arriving={!lost} onGrow={followBottom} />}

              {silent && (
                <div className="chat-surface mx-1 my-3">
                  <ModelSilent onRetry={retry} />
                </div>
              )}

              {problem && (
                <div className="chat-banner mx-1 my-3 flex items-center justify-between gap-4 rounded-xl border border-blood/40 px-4 py-3">
                  <p role="alert" className="text-sm text-blood">{problem}</p>
                  {!busy && !lost && !refusal && (
                    <button className="btn btn-ghost shrink-0 !py-1.5 text-xs" onClick={retry}>
                      {t("chat.errors.retryButton")}
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        <p role="status" className="sr-only">
          {heard.said && t(heard.said === "typing" ? "chat.stream.assistantTyping" : "chat.stream.replied", { name: character.name })}
          {heard.cut && ` ${heard.cut}`}
        </p>
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
          stopRef={stopButton}
          say={toast}
          above={<>{toastNode}{lostLine}</>}
          status={
            data.connections ? (
              // On a touch screen the chip takes the place of the keyboard's sentence.
              <ChatStatusRow keyboardHint={hasKeyboard() ? t("chat.input.hintDefault") : null}>
                {chipShown && <AiChip ai={answeringAi} onOpen={() => (answeringAi ? setAiSheet(true) : setAddingAi(true))} />}
              </ChatStatusRow>
            ) : (
              <ChatStatusRow keyboardHint={t(hasKeyboard() ? "chat.input.hintDefault" : "chat.input.hintTouch")}>
                {null}
              </ChatStatusRow>
            )
          }
        />
      </div>

      {panelOpen && (
        <ChatSidePanel
          conversation={conversation}
          backdrop={backdrop}
          persona={persona}
          storyCuts={storyCuts}
          takeFocus={panelByHand}
          onClose={() => showPanel(false)}
          onConversationChange={(patch) => {
            if ("summary" in patch) summaries.current += 1;
            setConversation((c) => (c ? { ...c, ...patch } : c));
          }}
          onShowCard={() => {
            setPanelByHand(false);
            setPanelOpen(false);
            setShowCard(true);
          }}
          onOpenDisplay={(focus) => {
            // Over the conversation, it would hide what is being judged.
            if (!wide) {
              setPanelByHand(false);
              setPanelOpen(false);
            }
            // Beside the conversation the panel stays, and the focus goes back to it by itself.
            openDisplay(focus === "strength", () => panelButton.current);
          }}
        />
      )}
      {displaySheet && (
        <Sheet
          title={t("display.title")}
          hint={t("display.sheetHint")}
          seeThrough
          alert={backdrop.failed !== null ? describeError(backdrop.failed, t) : null}
          returnTo={displaySheet.returnTo}
          onClose={() => setDisplaySheet(null)}
        >
          <DisplayControls
            where="conversation"
            conversation={conversation}
            backdrop={backdrop}
            focusStrength={displaySheet.focusStrength}
          />
        </Sheet>
      )}
      {aiSheet && ais && (
        <AiSheet
          conversation={conversation}
          ais={ais}
          room={room}
          onPick={switched}
          onAddOther={() => {
            setAiSheet(false);
            setAddingAi(true);
          }}
          onClose={() => setAiSheet(false)}
          onCapLifted={(saved) => {
            tookAi(saved);
            // Closed, so that the line saying it is read: on a phone the sheet covers it.
            setAiSheet(false);
            toast(t("ai.notice.capLifted", { name: saved.name }));
          }}
        />
      )}
      {addingAi && (
        <AddAiFlow
          origin={{ from: "conversation", conversationId: conversation.id }}
          onAdded={(result) => {
            setAis((now) => [...(now ?? []).filter((ai) => !result.models.some((made) => made.id === ai.id)), ...result.models]);
            setAddingAi(false);
            const chosen = result.models.find((ai) => ai.id === result.conversation?.model_id) ?? result.models.at(-1);
            if (chosen) switched(chosen);
          }}
          onClose={() => setAddingAi(false)}
        />
      )}
      {showCard && (
        <CardSummary character={character} personaName={persona?.name ?? null} onClose={() => setShowCard(false)} />
      )}
    </div>
  );
}
