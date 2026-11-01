import { ChatInput } from "@/components/chat/ChatInput";
import { ChatMessage } from "@/components/chat/ChatMessage";
import { ModelSilent } from "@/components/chat/ModelSilent";
import { ChatSidePanel } from "@/components/chat/ChatSidePanel";
import { RpText } from "@/components/chat/RpText";
import { Avatar } from "@/components/ui/Avatar";
import { DataError, data } from "@/data";
import { useT } from "@/i18n/useT";
import { describeError, describeEvent } from "@/lib/errors";
import { turnStore } from "@/lib/turnStore";
import type { ChatEvent, ContextStats, Conversation, Message, Persona, TurnPerf } from "@/types";
import { ArrowLeft, PanelRightOpen, SlidersHorizontal } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Link, useNavigate, useParams } from "react-router";

/** How long a turn goes without a word before a phone coming back asks about it.
 *  Asking costs little, since a reader can be replaced at any moment, and a model
 *  that is simply slow to start loses nothing by it. */
const QUIET_BEFORE_ASKING_MS = 5_000;
/** `online` and `visibilitychange` tend to arrive together as a phone wakes. */
const COMING_BACK_WAIT_MS = 400;
/** Readers in a row that may end with a reply unfinished and no new word, before
 *  the page stops taking the server's word for it that it is running. */
const CLOSES_WITHOUT_A_WORD = 5;

type TurnFailure = { event: Extract<ChatEvent, { type: "error" }> } | { error: unknown } | "no reply";

/** What asking the server about a turn came to. */
type TurnCheck =
  | { result: "unreachable" | "running" | "settled" }
  /** Nothing to show. It never reached the server, or it did and no reply came of
   *  it: the messages are what the server has, for asking again from. */
  | { result: "not sent" | "no reply"; messages: Message[] };

/** Enough of a message to tell whether a turn has touched it. */
const fingerprint = (message?: Message) => (message ? `${message.id}:${message.content}` : "");

/** A stream can also just end, when something between here and the server gives up
 *  on it. As far as the person can tell, Evermind has stopped answering. */
const streamEndedEarly = () => new DataError("The stream ended early.", { kind: "network" });

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
  const turnHere = turn?.conversationId === id ? turn : null;
  const busy = turnHere?.busy ?? false;
  const cutOff = turnHere !== null && !turnHere.busy;
  // The words of the reply being read, or of one cut off, if any had arrived.
  const streamText = turnHere && (turnHere.busy || turnHere.text) ? turnHere.text : null;
  const [regenTargetId, setRegenTargetId] = useState<string | null>(null);
  // What went wrong, described when drawn, so that a change of language reaches
  // the sentence too, and so that what follows a turn does not depend on it.
  const [failure, setFailure] = useState<TurnFailure | null>(null);
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
  // Counts what the person has done to the messages, so that a read sent before
  // one of those does not undo it.
  const changesByHand = useRef(0);
  // What this page last asked for, for telling whether it ever reached the server.
  const lastAsked = useRef<{
    mode: "send" | "regenerate" | "continue";
    content?: string;
    messageMode: "say" | "narrate" | "ooc";
    lastMessageBefore: string;
  } | null>(null);
  const checking = useRef<Promise<TurnCheck> | null>(null);

  /** What the events of a turn do to the page, whoever asked for the turn. */
  const applyTurnEvent = useCallback((event: ChatEvent) => {
    if (event.type === "start") {
      const real = event.user_message;
      if (!real) return;
      // In place of the one drawn when it was sent, and not added twice: a turn
      // can be read from its start more than once.
      setMessages((prev) => [
        ...prev.filter((m) => !m.id.startsWith("optimistic-") && m.id !== real.id),
        real,
      ].sort((a, b) => a.position - b.position));
    } else if (event.type === "delta") {
      turnStore.append(event.text);
    } else if (event.type === "done") {
      setMessages((prev) => {
        const others = prev.filter((m) => m.id !== event.message.id);
        return [...others, event.message].sort((a, b) => a.position - b.position);
      });
      if (event.context) setContextStats(event.context);
      if (event.perf) setPerf(event.perf);
    } else if (event.type === "error") {
      // A model that never answered is not a fault to raise the alarm
      // about; usually the server behind it is simply not running.
      if (event.kind === "unreachable") setSilent(true);
      else setFailure({ event });
    }
  }, []);

  /** Read a turn from its first word, which is where a reader starts. Says whether
   *  it saw the turn end, and how, and what broke the reading, if anything did. */
  const readTurn = useCallback(async (controller: AbortController, arriving: boolean) => {
    let failed = false;
    let ended = false;
    try {
      await data.turns.follow(id, (event) => {
        if (event.type === "start") {
          // A page arriving knows nothing of the turn yet. A regeneration replaces
          // a reply rather than adding one; without knowing which, the page shows
          // both the old reply and its replacement arriving underneath. Otherwise
          // the page already knows that, and it is the words that start again.
          if (arriving) setRegenTargetId(event.target_message_id ?? null);
          else turnStore.restart(controller);
        } else if (event.type === "error") {
          failed = true;
          ended = true;
        } else if (event.type === "done") {
          ended = true;
        }
        applyTurnEvent(event);
      }, controller.signal);
      return { failed, ended };
    } catch (error) {
      return { failed, ended, broken: controller.signal.aborted ? undefined : error };
    }
  }, [id, applyTurnEvent]);

  const finishReading = useCallback((controller: AbortController) => {
    if (turnStore.end(controller)) setRegenTargetId(null);
  }, []);

  /** Read the conversation, and put it on screen unless the person has changed a
   *  message since the read was sent. Nearly always it says what is there already,
   *  and then that is left alone rather than every message being drawn twice. */
  const readAgain = useCallback(async () => {
    const changes = changesByHand.current;
    const latest = (await data.conversations.get(id)).messages ?? [];
    return {
      latest,
      show() {
        if (changesByHand.current !== changes) return;
        setMessages((shown) => (JSON.stringify(shown) === JSON.stringify(latest) ? shown : latest));
      },
    };
  }, [id]);

  const { checkOnTurn, pickTurnBackUp, readToTheEnd } = useMemo(() => {
    /** Ask the server about the turn and act on the answer. A reply being written
     *  is read from its first word by a new reader; one that has just ended is
     *  handed over with its ending; and otherwise the conversation says how things
     *  stand. Whoever asks while this is going gets the same answer. */
    function checkOnTurn(): Promise<TurnCheck> {
      checking.current ??= ask().finally(() => {
        checking.current = null;
      });
      return checking.current;
    }

    async function ask(): Promise<TurnCheck> {
      try {
        const state = await data.turns.state(id);
        if (state.running) {
          const reader = new AbortController();
          turnStore.handOver(id, reader);
          setFailure(null);
          void readToTheEnd(reader, false);
          return { result: "running" };
        }
        if (state.ended_recently) {
          // Nothing more can come of this one, so nothing further to ask.
          const reader = new AbortController();
          turnStore.handOver(id, reader);
          setFailure(null);
          const { failed, broken } = await readTurn(reader, false);
          if (broken !== undefined) {
            turnStore.lose(reader, broken);
            return { result: "unreachable" };
          }
          if (failed) {
            // The failure is what the person is told. Nothing came of the turn, so
            // somebody asking again really is asking for something new.
            finishReading(reader);
            const { latest, show } = await readAgain();
            show();
            return { result: "no reply", messages: latest };
          }
        }

        const reader = turnStore.readerOf(id);
        const { latest, show } = await readAgain();
        // Something else took over while that was on its way.
        if (turnStore.readerOf(id) !== reader) return { result: "running" };
        show();
        turnStore.drop(reader);
        setRegenTargetId(null);

        const last = latest.at(-1);
        if (fingerprint(last) === lastAsked.current?.lastMessageBefore) {
          setFailure("no reply");
          return { result: "not sent", messages: latest };
        }
        if (last?.role !== "assistant") {
          setFailure("no reply");
          return { result: "no reply", messages: latest };
        }
        setFailure(null);
        return { result: "settled" };
      } catch {
        return { result: "unreachable" };
      }
    }

    /** A reader ended without seeing the turn end. A phone went to sleep or lost its
     *  wifi, or something between here and the server gave up on the stream, and
     *  the turn, being the server's, has not noticed. So what had arrived stays up,
     *  and so does the stop button, until the server has said how things stand. If
     *  it cannot be reached the person is told, rather than left looking at a reply
     *  that has silently stopped, and a phone coming back tries again. So they are
     *  too if readers keep ending with nothing to show for it. */
    async function pickTurnBackUp(controller: AbortController, why: unknown) {
      if (controller.signal.aborted) return;
      if (turnStore.closedEarly() >= CLOSES_WITHOUT_A_WORD) {
        turnStore.lose(controller, why);
        return;
      }
      const { result } = await checkOnTurn();
      if (result === "unreachable" && !controller.signal.aborted) turnStore.lose(controller, why);
    }

    /** Read a turn until it ends, whatever that takes. */
    async function readToTheEnd(reader: AbortController, arriving: boolean) {
      const { ended, broken } = await readTurn(reader, arriving);
      if (!ended) await pickTurnBackUp(reader, broken ?? streamEndedEarly());
      finishReading(reader);
    }

    return { checkOnTurn, pickTurnBackUp, readToTheEnd };
  }, [id, readTurn, finishReading, readAgain]);

  // A phone coming back. Sleeping is when a connection goes, sometimes with an
  // error that came too soon to do anything about, and sometimes without one: a
  // stream can simply stop. Each event is worth one question, and only if there is
  // something to ask: a reply cut off, or one that has gone quiet. If the server is
  // still out of reach, things stay as they are until the next event.
  useEffect(() => {
    let waiting: ReturnType<typeof setTimeout> | undefined;
    const ask = () => {
      const here = turnStore.read();
      if (here?.conversationId !== id) return;
      if (!here.busy || turnStore.quietFor() >= QUIET_BEFORE_ASKING_MS) void checkOnTurn();
    };
    const comingBack = () => {
      if (document.visibilityState !== "visible") return;
      clearTimeout(waiting);
      waiting = setTimeout(ask, COMING_BACK_WAIT_MS);
    };
    window.addEventListener("online", comingBack);
    document.addEventListener("visibilitychange", comingBack);
    return () => {
      clearTimeout(waiting);
      window.removeEventListener("online", comingBack);
      document.removeEventListener("visibilitychange", comingBack);
    };
  }, [id, checkOnTurn]);

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

    void (async () => {
      if (turnStore.isRunning(id)) return; // this page is already the one running it
      // Left from a reply cut off before the person went elsewhere. They are back
      // at the start, and it will be read like everything else.
      turnStore.drop(turnStore.readerOf(id));
      const state = await data.turns.state(id);
      if (controller.signal.aborted) return;
      if (state.running) {
        // Watch a reply that is being written elsewhere — by a server that carried
        // on after the phone that asked for it went to sleep.
        turnStore.begin(id, controller);
        await readToTheEnd(controller, true);
      } else if (!state.ended_recently) {
        return;
      }
      // The conversation and the state of the turn are two reads, not one moment.
      // A turn that ended between them leaves a reply as far as it had got, with
      // no turn to watch and so nothing coming to replace it. What was read cannot
      // say so, since only a new reply is marked while it is written, but the
      // server can. The same goes for a read still on its way when the turn this
      // page attached to ended. Once more is enough: nothing was running when this
      // is asked for.
      await opening;
      if (controller.signal.aborted) return;
      const { show } = await readAgain();
      if (controller.signal.aborted || turnStore.isRunning(id)) return;
      show();
    })().catch(() => {
      /* whatever was read first stays on screen, or its failure is reported above */
    });

    return () => controller.abort();
  }, [id, readToTheEnd, readAgain]);

  /** Fetch the conversation again. */
  const reload = useCallback(async () => {
    if (!conversation) return;
    await data.conversations
      .get(conversation.id)
      .then((convo) => setMessages(convo.messages ?? []))
      .catch(() => {}); // keep current state
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
      // Nothing can be read while cut off, and what is kept is what is on screen.
      if (cutOff) return;
      reload();
    }
  }, [busy, cutOff, reload]);

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
    known: Message[] = messages,
  ) {
    if (!conversation || busy) return;
    setFailure(null);
    setSilent(false);
    stickToBottom.current = true;
    const controller = new AbortController();
    setBeforeTurn(new Set(known.map((m) => m.id)));
    turnStore.begin(conversation.id, controller);
    lastAsked.current = { mode, content, messageMode, lastMessageBefore: fingerprint(known.at(-1)) };

    // The sent message appears instantly; the persisted version from the
    // `start` event replaces it (or it is rolled back if nothing was saved).
    const optimisticId = mode === "send" ? `optimistic-${Date.now()}` : null;
    if (optimisticId && content) {
      const lastPosition = known.length ? known[known.length - 1].position : -1;
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
      const last = known[known.length - 1];
      setRegenTargetId(last?.role === "assistant" ? last.id : null);
    } else {
      setRegenTargetId(null);
    }

    let finished = false;

    const onEvent = (event: ChatEvent) => {
      if (event.type === "start") {
        startReceived = true;
        if (!conversation.title && content && messageMode === "say") {
          setConversation((c) => (c ? { ...c, title: content.slice(0, 60) } : c));
        }
      } else if (event.type === "done" || event.type === "error") {
        finished = true;
      }
      applyTurnEvent(event);
    };

    try {
      await data.turns.send(
        { conversation_id: conversation.id, mode, content, message_mode: messageMode },
        onEvent,
        controller.signal,
      );
      if (!finished) {
        // Stream closed without done/error. Stopped somewhere else, or given up on
        // by something between here and the server, which is no end to the turn.
        await pickTurnBackUp(controller, streamEndedEarly());
      }
    } catch (e) {
      if (controller.signal.aborted) {
        // Stopped, in which case the backend persisted the partial text. Unless it
        // was only this connection that was given up on, for another reader.
        if (turnStore.readerOf(conversation.id) === controller) await reload();
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
        await pickTurnBackUp(controller, e);
      } else if (e instanceof DataError && e.kind === "network") {
        // Failing before it began means the message may never have been sent,
        // which is worth saying, and a phone coming back asks whether it was.
        turnStore.lose(controller, e);
      } else {
        // Evermind answered, and said no.
        await reload();
        setFailure({ error: e });
      }
    }

    // Transport died or the turn failed before anything was persisted:
    // withdraw the optimistic bubble so the display matches the server.
    if (optimisticId && !startReceived) {
      setMessages((prev) => prev.filter((m) => m.id !== optimisticId));
    }

    finishReading(controller);
  }

  /** Trying again after a connection was lost asks first: the reply may be being
   *  written, or be there already, and asking for it again would make another. */
  async function retry() {
    if (!cutOff && failure !== "no reply") {
      await runTurn("regenerate");
      return;
    }
    if (checking.current) return;
    const check = await checkOnTurn();
    if (check.result === "not sent" && lastAsked.current) {
      const { mode, content, messageMode } = lastAsked.current;
      await runTurn(mode, content, messageMode, check.messages);
    } else if (check.result === "no reply" || check.result === "not sent") {
      await runTurn("regenerate", undefined, "say", check.messages);
    }
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

  async function deleteFrom(message: Message) {
    if (!confirm(t("chat.message.confirmDeleteFrom"))) return;
    await data.messages.removeFrom(message.id);
    changesByHand.current += 1;
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
  const problem = cutOff
    ? describeError(turnHere.lost, t, t("chat.errors.connectionFailed"))
    : failure === "no reply"
      ? t("chat.errors.noReply")
      : failure === null
        ? null
        : "event" in failure
          ? describeEvent(failure.event, t)
          : describeError(failure.error, t, t("chat.errors.connectionFailed"));
  // While regenerating an existing message, hide it (its replacement streams
  // below). A reply still being written is hidden the same way while its turn is
  // live: the backend saves it as it goes, so arriving mid-turn would otherwise
  // show the same text twice, once from the database and once from the stream.
  // Only one that arrived with the turn, though. A reply left marked from an
  // earlier turn that was cut off was hidden too, so it disappeared for the
  // length of every later generation — including the one continuing it.
  const visibleMessages = messages.filter((m) => {
    if (regenTargetId && streamText !== null && m.id === regenTargetId) return false;
    if (streamText !== null && m.meta?.streaming && !beforeTurn.has(m.id)) return false;
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
                      <RpText text={streamText} streaming={busy} />
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
                  <button className="btn btn-ghost shrink-0 !py-1.5 text-xs" onClick={retry}>
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
