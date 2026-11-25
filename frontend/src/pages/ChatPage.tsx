import { AddAiFlow } from "@/components/ai/AddAiFlow";
import { AiChip, AiSheet, AiUnread } from "@/components/chat/AiSheet";
import { Backdrop } from "@/components/chat/Backdrop";
import { CardSummary } from "@/components/chat/CardSummary";
import { ChatInput } from "@/components/chat/ChatInput";
import { ChatMessage } from "@/components/chat/ChatMessage";
import { ModelSilent } from "@/components/chat/ModelSilent";
import { ChatSidePanel } from "@/components/chat/ChatSidePanel";
import { ChatStatusRow } from "@/components/chat/ChatStatusRow";
import { useChatToast } from "@/components/chat/ChatToast";
import { WayChip } from "@/components/chat/WayChip";
import { WaySheet } from "@/components/chat/WaySheet";
import { RpText } from "@/components/chat/RpText";
import { useConversationBackdrop } from "@/components/chat/useConversationBackdrop";
import { DisplayControls } from "@/components/display/DisplayControls";
import { Avatar } from "@/components/ui/Avatar";
import { PageWait } from "@/components/ui/PageWait";
import { Sheet } from "@/components/ui/Sheet";
import { DataError, data, type AiSaved, type Asking, type TurnRequest } from "@/data";
import { useT } from "@/i18n/useT";
import { answering, sizeTold } from "@/lib/ai";
import { backdropOf, plateAlpha, useDisplay } from "@/lib/display";
import { beginSending, type MessageMode } from "@/lib/drafts";
import { cutAtCeilingOf, describeCut } from "@/lib/cutShort";
import { describeError, describeFailure, isUnanswered } from "@/lib/errors";
import { memoryFailed } from "@/lib/memoryMark";
import { holdSizes, wantSizes } from "@/lib/portraitSizes";
import { PATIENCE_MS, useTurn, type LiveText } from "@/lib/useTurn";
import { hasKeyboard, newId, nothingFocused, smallPortrait } from "@/lib/utils";
import { clsx } from "clsx";
import type { Ai, Character, Conversation, Message, Outlook, Persona, TurnFailure } from "@/types";
import { ArrowLeft, SlidersHorizontal } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
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

/** What the server counted `ai` read of a reply, when it read only the end of the story
 *  (`meta.truncated`): only for the version on screen, read by that AI under the model it runs now,
 *  as the mark names them. Null for any other reply, and for a mark that names none of them. */
function readOnlyTheEnd(message: Message, ai: Ai | null): { read: number; window: number } | null {
  const said = message.meta?.truncated as
    { read?: unknown; window?: unknown; version?: unknown; model_id?: unknown; model?: unknown } | undefined;
  if (!said || !ai || typeof said.read !== "number" || typeof said.window !== "number") return null;
  if (said.version !== message.active_index || said.model_id !== ai.id || said.model !== ai.model) return null;
  return { read: said.read, window: said.window };
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
  // The AIs, where the edition keeps its own: read with the page, and again when the sheet that
  // changes them opens or the conversation names one the page does not hold (changed on another
  // device). Null until read; `aisUnread` once a read failed with nothing read before it.
  const [ais, setAis] = useState<Ai[] | null>(null);
  const [aisUnread, setAisUnread] = useState(false);
  const aisHeld = useRef<Ai[] | null>(null);
  useEffect(() => {
    aisHeld.current = ais;
  }, [ais]);
  // The last read sent is the one that counts: an earlier one answering late does not undo it.
  const aisAsked = useRef(0);
  const readAis = useCallback(() => {
    const models = data.connections?.models;
    if (!models) return;
    const sent = ++aisAsked.current;
    models.list().then(
      (listed) => {
        if (sent !== aisAsked.current) return;
        setAis(listed);
        setAisUnread(false);
      },
      // Caught: offline it rejects, and an unhandled rejection is noise in the console.
      () => {
        if (sent === aisAsked.current) setAisUnread(true);
      },
    );
  }, []);
  /** A change the page makes to its own list (a ceiling lifted, an AI added, a row dropped): a read
   *  sent before it, answering late, would put back the list from before. */
  const changeAis = useCallback((change: (now: Ai[] | null) => Ai[] | null) => {
    aisAsked.current += 1;
    setAis(change);
  }, []);
  const [aiSheet, setAiSheet] = useState(false);
  const aiSheetShown = useRef(false);
  const [addingAi, setAddingAi] = useState(false);

  // What the conversation's AI reads of it under its way, for the way's chip: read as the story is
  // first shown, at each turn's end, and when the AI or the way changes. The last sent counts.
  const [glance, setGlance] = useState<Outlook["current"] | null>(null);
  const glanceAsked = useRef(0);
  const readGlance = useCallback(() => {
    const sent = ++glanceAsked.current;
    data.conversations.outlook(id, { only: "current" }).then(
      (read) => {
        if (sent === glanceAsked.current) setGlance(read.current);
      },
      // The chip keeps what it said, or the way's name: nothing to tell.
      () => {},
    );
  }, [id]);
  // The whole of it, every AI and every way, for the two sheets: read as either opens, kept until
  // the next turn ends.
  const [whole, setWhole] = useState<Outlook | null>(null);
  const wholeAsked = useRef(0);
  // From a read of the whole until the last one sent settles, either way: the AIs' sheet draws its
  // rows once, with their figures or without, rather than growing under a touch as they come.
  const [wholeReading, setWholeReading] = useState(false);
  const [waySheet, setWaySheet] = useState(false);
  const waySheetShown = useRef(false);
  // The read of the whole, for what runs outside a render (a turn's end, a read of the story).
  const rereadWhole = useRef<() => void>(() => {});
  /** What the next turn would read may have changed: an open sheet reads the whole again, keeping
   *  its figures meanwhile, as nothing else reads them while it stays open; otherwise the chip's
   *  pair is read, and the whole waits for a sheet to open. */
  const outlookChanged = useCallback(() => {
    if (waySheetShown.current || aiSheetShown.current) return rereadWhole.current();
    setWhole(null);
    readGlance();
  }, [readGlance]);
  useEffect(() => {
    if (!data.connections) return;
    readAis();
  }, [readAis]);
  /** Every AI under the way and every way with the AI, for a sheet opening: what was held shows
   *  meanwhile. It says the chip's pair too, newer than a short read sent before it. */
  function readWhole() {
    const sent = ++wholeAsked.current;
    const glanceAt = ++glanceAsked.current;
    setWholeReading(true);
    data.conversations.outlook(id).then(
      (read) => {
        if (glanceAt === glanceAsked.current) setGlance(read.current);
        if (sent !== wholeAsked.current) return;
        setWhole(read);
        setWholeReading(false);
      },
      (error) => {
        if (sent !== wholeAsked.current) return;
        setWholeReading(false);
        // The sheet of the ways has nothing to show without it: it closes, and the line over the
        // input says why. The AIs' sheet does without its figures.
        if (!waySheetShown.current) return;
        closeWaySheet();
        setWriteError({ error });
      },
    );
  }
  useEffect(() => {
    rereadWhole.current = readWhole;
  });

  function openAiSheet() {
    // What the page holds at once, and the list as it is now once it comes.
    aiSheetShown.current = true;
    setAiSheet(true);
    readAis();
    readWhole();
  }

  function closeAiSheet() {
    aiSheetShown.current = false;
    setAiSheet(false);
  }

  function openWaySheet() {
    waySheetShown.current = true;
    setWaySheet(true);
    readWhole();
  }

  function closeWaySheet() {
    waySheetShown.current = false;
    setWaySheet(false);
  }

  /** The conversation as the sheet of the ways saved it: another way, or an adjustment. */
  function playing(saved: Conversation) {
    setConversation((c) => (c ? { ...c, play_style: saved.play_style, play_overrides: saved.play_overrides } : c));
    // The sheet still open after an adjustment shows the figures it changed; closed, the chip does.
    outlookChanged();
  }

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

  // What the page shows of the conversation, for a read to compare with what it brings.
  const shownConversation = useRef<Conversation | null>(null);
  useEffect(() => {
    shownConversation.current = conversation;
  }, [conversation]);

  // The messages, the title, which the server gives a new conversation, the summary for a closed
  // panel, and the AI that answers it, which another device may have changed or removed.
  const read = useCallback(async (asking: Asking) => {
    const changes = changesByHand.current;
    const takeSummary = summaryTaker();
    const conversation = await data.conversations.get(id, asking);
    const show = () => {
      if (changesByHand.current !== changes) return false;
      takeSummary(conversation);
      const before = shownConversation.current;
      const held = aisHeld.current;
      // An AI the page does not hold, or one just said removed: the list changed elsewhere. None
      // named: the default answers, which another device may have changed. No list held: the read
      // as the page opened failed. Not as the page opens, whose own read of the list is on its way.
      if (before && (
        held === null
        || !conversation.model_id
        || !held.some((ai) => ai.id === conversation.model_id)
        || (conversation.model_lost && conversation.model_lost !== before.model_lost)
      )) readAis();
      // Another AI or another way, chosen on another device: what it reads is read again.
      if (before && (
        conversation.model_id !== before.model_id
        || conversation.play_style !== before.play_style
        || JSON.stringify(conversation.play_overrides) !== JSON.stringify(before.play_overrides)
      )) outlookChanged();
      setConversation((shown) => (shown
        ? {
            ...shown,
            title: conversation.title,
            model_id: conversation.model_id,
            model_lost: conversation.model_lost,
            play_style: conversation.play_style,
            play_overrides: conversation.play_overrides,
          }
        : conversation));
      setMessages(conversation.messages ?? []);
      return true;
    };
    return { conversation, show };
  }, [id, summaryTaker, readAis, outlookChanged]);

  // The person's message as the server saved it, before the conversation is read again.
  const add = useCallback((sent: Message) => {
    setMessages((now) => [...now.filter((m) => m.id !== sent.id), sent].sort((a, b) => a.position - b.position));
  }, []);

  // A reply asked for again or carried on takes back a memory that read it: an open panel reads it at
  // the turn's end, once the page shows the story with nothing being written. That is also when the
  // request's answer was lost and the page found the turn already over, never having seen it run.
  // The same moment reads what the next turn would read: the story has moved, and the way or the AI
  // may have changed elsewhere. As the page opens, that is its first read of it.
  const rewriting = useRef(false);
  const settled = useCallback(() => {
    outlookChanged();
    if (!rewriting.current) return;
    rewriting.current = false;
    setStoryCuts((n) => n + 1);
  }, [outlookChanged]);

  const turn = useTurn(id, read, add, settled);
  const { writing, text, lost, outcome, refused, stop, forget } = turn;
  const busy = writing !== null;
  const { toast, node: toastNode, heard: toastHeard } = useChatToast(busy);

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
    const cut = said === "replied" && newest?.role === "assistant" ? (describeCut(newest, t)?.text ?? null) : null;
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

  // The keyboard's sentence under the input steps aside while the line over the input is said, only
  // where the three do not fit: the line's sentence whole, a line of the story over its padding (the
  // flex-basis of the story's box), and the keyboard's sentence. Aside, it is measured at no height in
  // its place, and comes back only where the story keeps that line with it: the two answers never
  // undo each other. Decided before the frame is painted.
  const [sentenceNode, setSentenceNode] = useState<HTMLParagraphElement | null>(null);
  const [hintAside, setHintAside] = useState(false);
  // Watched from before the line's first frame: the observer's first word comes before it is painted.
  useLayoutEffect(() => {
    if (!storyNode || !sentenceNode || !hasKeyboard()) return;
    const check = () => {
      const hint = document.querySelector<HTMLElement>("[data-status-row] [data-keyboard-hint]");
      if (!hint) return;
      const line = parseFloat(getComputedStyle(storyNode.parentElement!).flexBasis) || 0;
      const whole = sentenceNode.scrollHeight <= sentenceNode.clientHeight + 1;
      const room = storyNode.clientHeight + 1 - (hint.dataset.aside !== undefined ? hint.scrollHeight : 0);
      flushSync(() => setHintAside(!(whole && room >= line)));
    };
    const watch = new ResizeObserver(check);
    watch.observe(storyNode);
    watch.observe(sentenceNode);
    return () => watch.disconnect();
  }, [storyNode, sentenceNode]);

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
    closeAiSheet();
    // Another AI chosen: the line saying one was removed goes with it, as on the server.
    setConversation((c) => (c ? { ...c, model_id: ai.id, model_lost: null } : c));
    outlookChanged();
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

  /** An AI as the server saved it, in the list the page holds; what it reads may change with it. */
  function tookAi(saved: AiSaved) {
    changeAis((now) => now && now.map((ai) => (ai.id === saved.id ? saved : ai)));
    outlookChanged();
  }

  /** An AI the server no longer has, picked in the sheet: its row goes, and the list is read again. */
  function aiGone(gone: Ai) {
    changeAis((now) => now && now.filter((ai) => ai.id !== gone.id));
    readAis();
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

  /** Long replies in this conversation alone, for a reply that filled the room its way keeps: the
   *  conversation as the server saved it, what the next turn reads read again, then said. */
  async function longHere() {
    try {
      const saved = await data.conversations.update(id, {
        play_overrides: { ...(conversation?.play_overrides ?? {}), reply_length: "long" },
      });
      playing(saved);
      toast(t("chat.message.longHereDone"));
    } catch (error) {
      toast(describeError(error, t));
    }
  }

  // What the server counted that the AI read of the last reply, when it read only the end of the
  // story: it reads less than it is counted to.
  const [shrinking, setShrinking] = useState(false);
  /** The size the server showed, kept on the AI, then the reply written again within it. */
  async function shrink(ai: Ai, read: number) {
    setShrinking(true);
    try {
      tookAi(await data.connections!.models.observed(ai.id, read));
    } catch (error) {
      toast(describeError(error, t));
      return;
    } finally {
      setShrinking(false);
    }
    void ask({ mode: "regenerate" });
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
  // What answers it, where the edition keeps AIs of its own; drawn once they are read.
  const chipShown = data.connections !== undefined && ais !== null;
  const answeringAi = ais ? answering(conversation.model_id, ais) : null;
  const silent = failure?.kind === "unreachable";
  // That another reply is being written, only as long as it is.
  const refusal = refused instanceof DataError && refused.kind === "turn_running" && !busy ? null : refused;
  // Refused as too long twice: said with the AI's name where the page knows it, and asked again,
  // which sends less now that the server has said how much it reads.
  const tooLong = !lost && !refusal && failure?.kind === "model_too_long";
  const problem = lost || refusal
    ? describeError(lost || refusal, t, t("chat.errors.connectionFailed"))
    : tooLong && answeringAi
      ? t("chat.tooLong", { name: answeringAi.name })
      : failure?.kind === "nothing_added"
        ? t("chat.errors.nothingAdded")
        : failure && !silent
          ? describeFailure(failure, t)
          : unanswered === true
            ? t("chat.errors.noReply")
            : null;
  // The message being written is drawn from its words as they arrive.
  const visibleMessages = messages.filter((m) => m.id !== writing);
  const shown = backdropOf(conversation, character, display);
  // The plate under the text, only where a picture is drawn: with none, nothing changes.
  const veiled = shown.src !== null && shown.strength > 0;
  const drawnMessages = visibleMessages.slice(-drawn);
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
  // The last reply was read by an AI that saw only the end of the story: said over the input, where
  // it is seen, until the next reply. Only for the version shown, and the AI that answers now under
  // the model it was counted for: what another read says nothing of what this one reads.
  // On a short screen with large text, what gives way, in this order: the keyboard's sentence under
  // the input; the line's sentence, down to one whole line of its text, scrolling in its own part
  // with its shade at the foot; then the story's own line (see the story's box). Its button never
  // gives way, the only thing to do about it. Both parts sit in the column itself, so the story
  // yields before the button.
  const truncated = !busy && last?.role === "assistant" ? readOnlyTheEnd(last, answeringAi) : null;
  const truncatedAi = truncated ? answeringAi : null;
  const truncatedLine = truncated && truncatedAi && data.connections && (
    <div data-truncated className="contents">
      <p
        ref={setSentenceNode}
        data-truncated-text
        // At least one line of its text (text-xs: 1rem) under its padding and its border.
        className="scroll-cue min-h-[calc(1.5rem+1px)] shrink-[1000] overflow-y-auto border-t border-ink-700 px-4 pt-2 text-center text-xs text-parchment-dim [overflow-wrap:anywhere]"
      >
        <span className="mx-auto block max-w-3xl">
          {t("chat.truncated.text", { name: truncatedAi.name, read: truncated.read, window: truncated.window })}
        </span>
      </p>
      {/* In a column narrower than any phone's, thinner sides, so that its words stand whole. */}
      <div className="flex shrink-0 justify-center bg-ink-900 px-4 pb-2 pt-1 @max-[240px]/column:px-[8px]">
        <button
          type="button"
          className="btn btn-ghost touch-target max-w-full whitespace-normal !py-1 text-xs @max-[240px]/column:!px-[8px]"
          disabled={shrinking}
          onClick={() => void shrink(truncatedAi, truncated.read)}
        >
          {t("chat.truncated.button")}
        </button>
      </div>
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
            the text moves, and follows the column as the keyboard opens or the panel takes a share.
            It starts from a line of its text over its bottom padding: the line over the input, which
            gives way a thousand times faster, leaves it that much until its sentence is down to a
            line of its own; then the story yields. */}
        <div className="relative min-h-0 flex-[1_1_calc(1.8rem*var(--chat-scale,1)+1.5rem)]">
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
                  // Only the ceiling that cut this version: of the AI that wrote it, as it was then.
                  onLetEvermind={message.id === last?.id && answeringAi && cutAtCeilingOf(message, answeringAi)
                    ? () => letEvermind(answeringAi)
                    : undefined}
                  // Not once this conversation already asks for long replies.
                  onLongHere={message.id === last?.id && conversation.play_overrides?.reply_length !== "long"
                    ? longHere
                    : undefined}
                />
              ))}

              {busy && <StreamBubble text={text} character={character} arriving={!lost} onGrow={followBottom} />}

              {silent && (
                <div className="chat-surface mx-1 my-3">
                  <ModelSilent onRetry={retry} />
                </div>
              )}

              {/* The sentence takes the width; the button goes under it when both do not fit side by side. */}
              {problem && (
                <div className="chat-banner mx-1 my-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-xl border border-blood/40 px-4 py-3">
                  <p role="alert" className="min-w-0 flex-[1_1_12rem] text-sm text-blood">{problem}</p>
                  {!busy && !lost && !refusal && (
                    <button className="btn btn-ghost max-w-full shrink-0 whitespace-normal !py-1.5 text-xs" onClick={retry}>
                      {t(tooLong ? "chat.truncated.button" : "chat.errors.retryButton")}
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* The page's one status line, which says the toasts too: each part is heard as it changes. */}
        <p role="status" aria-atomic="false" className="sr-only">
          {heard.said && t(heard.said === "typing" ? "chat.stream.assistantTyping" : "chat.stream.replied", { name: character.name })}
          {heard.cut && ` ${heard.cut}`}
          {toastHeard}
        </p>
        {/* Out of the scrolling: what failed may be far above, or in the header. */}
        {writeError && (
          <p role="alert" className="border-t border-ink-700 bg-ink-900 px-4 py-2 text-center text-sm text-blood">
            {describeError(writeError.error, t)}
          </p>
        )}
        {truncatedLine}
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
            // On a touch screen the chips take the place of the keyboard's sentence. It steps aside while
            // the line over the input is said, where there is no room for both and a line of the story.
            <ChatStatusRow keyboardHint={hasKeyboard() ? t("chat.input.hintDefault") : null} hintAside={Boolean(truncatedLine) && hintAside}>
              {data.connections && (chipShown
                ? <AiChip ai={answeringAi} onOpen={() => (answeringAi ? openAiSheet() : setAddingAi(true))} />
                : aisUnread && <AiUnread onRetry={readAis} />)}
              <WayChip
                current={glance}
                playStyle={conversation.play_style}
                playOverrides={conversation.play_overrides}
                capacityTold={!answeringAi || sizeTold(answeringAi)}
                onOpen={openWaySheet}
              />
            </ChatStatusRow>
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
          outlook={whole}
          // Read again after a turn, the figures it holds stay drawn meanwhile.
          waiting={wholeReading && whole === null}
          onPick={switched}
          onGone={aiGone}
          onAddOther={() => {
            closeAiSheet();
            setAddingAi(true);
          }}
          onClose={closeAiSheet}
          onCapLifted={(saved) => {
            tookAi(saved);
            // Closed, so that the line saying it is read: on a phone the sheet covers it.
            closeAiSheet();
            toast(t("ai.notice.capLifted", { name: saved.name }));
          }}
        />
      )}
      {waySheet && (
        <WaySheet
          conversation={conversation}
          // Until the whole outlook comes, the reading the chip holds, the rows on their way; with
          // neither, the sheet opens all the same, as the touch asked.
          outlook={whole ?? (glance && { current: glance, models: [], ways: [] })}
          ais={data.connections ? ais : null}
          onPicked={playing}
          onClose={closeWaySheet}
          onLetEvermind={(ai) => {
            // Closed, so that the line saying it is read: on a phone the sheet covers it.
            closeWaySheet();
            void letEvermind(ai);
          }}
        />
      )}
      {addingAi && (
        <AddAiFlow
          origin={{ from: "conversation", conversationId: conversation.id }}
          onAdded={(result) => {
            changeAis((now) => [...(now ?? []).filter((ai) => !result.models.some((made) => made.id === ai.id)), ...result.models]);
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
