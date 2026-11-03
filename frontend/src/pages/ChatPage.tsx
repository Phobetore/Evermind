import { ChatInput } from "@/components/chat/ChatInput";
import { ChatMessage } from "@/components/chat/ChatMessage";
import { ModelSilent } from "@/components/chat/ModelSilent";
import { ChatSidePanel } from "@/components/chat/ChatSidePanel";
import { RpText } from "@/components/chat/RpText";
import { Avatar } from "@/components/ui/Avatar";
import { DataError, data } from "@/data";
import { useT } from "@/i18n/useT";
import {
  beginSending, forgetSending, giveBack, givenBack, isSending, sendAgain, settleSending, stillInBox, type Sending,
} from "@/lib/drafts";
import { describeError, describeEvent } from "@/lib/errors";
import { turnStore, type TurnFailure } from "@/lib/turnStore";
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
/** How long a question asked in order to recover is waited for. On a connection that
 *  has died without saying so it would otherwise never be answered, and nothing else
 *  could be asked in the meantime. */
const QUESTION_TIMEOUT_MS = 10_000;

/** What asking the server about a turn came to. */
type TurnCheck =
  /** "superseded": something happened meanwhile that makes the answer out of date,
   *  the person having stopped the turn or asked for another. */
  | { result: "unreachable" | "running" | "superseded" }
  /** The server has what is below, and that is how things stand. "not sent": it
   *  never reached the server. "no reply": it did, and no reply came of it. */
  | { result: "settled" | "not sent" | "no reply"; messages: Message[] };

/** The answer to a question, or a failure if it takes too long. */
function inTime<T>(question: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new DataError("No answer in time.", { kind: "network" })),
      QUESTION_TIMEOUT_MS,
    );
  });
  return Promise.race([question, late]).finally(() => clearTimeout(timer));
}

/** Enough of a message to tell whether a turn has touched it. */
const fingerprint = (message?: Message) => (message ? `${message.id}:${message.content}` : "");

/** A stream can also just end, when something between here and the server gives up
 *  on it. As far as the person can tell, Evermind has stopped answering. */
const streamEndedEarly = () => new DataError("The stream ended early.", { kind: "network" });

/** The server's word for it that the conversation's last message is still waiting
 *  for a reply. Where a conversation ends says nothing by itself: a reply can have
 *  been deleted, or stopped before its first word, or a story branched there. */
function unanswered(messages: Message[]) {
  const last = messages.at(-1);
  return last?.role === "user" && last.meta?.unanswered === true;
}

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
  const turn = useSyncExternalStore(turnStore.subscribe, () => turnStore.read(id));
  const busy = turn?.busy ?? false;
  const cutOff = turn !== null && !turn.busy;
  const asking = useSyncExternalStore(turnStore.subscribe, () => turnStore.isAsking(id));
  // The words of the reply being read, or of one cut off, if any had arrived.
  const streamText = turn && (turn.busy || turn.text) ? turn.text : null;
  const [regenTargetId, setRegenTargetId] = useState<string | null>(null);
  const failure: TurnFailure | null = useSyncExternalStore(
    turnStore.subscribe,
    () => turnStore.failureOf(id),
  );
  // A model that never answered is not a fault to raise the alarm about; usually
  // the server behind it is simply not running.
  const silent = typeof failure === "object" && failure !== null && "event" in failure
    && failure.event.kind === "unreachable";
  const [panelOpen, setPanelOpen] = useState(true); // desktop, inline column
  // Phones: the panel covers the conversation, so a backdrop cannot be judged
  // from inside it. Adjusting closes the panel and leaves a bar over the real
  // thing instead.
  const [adjustingWallpaper, setAdjustingWallpaper] = useState(false);
  const opacityWrite = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [mobilePanelOpen, setMobilePanelOpen] = useState(false); // phone, overlay
  // The error itself, described when drawn, so that a change of language
  // reaches the sentence too.
  const [loadFailure, setLoadFailure] = useState<{ error: unknown } | null>(null);
  // Counts the times the story was cut back, for the side panel to read the facts again.
  const [storyCuts, setStoryCuts] = useState(0);
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
  // Counts the reads of the conversation, the last of which knows the most.
  const readsSent = useRef(0);
  const checking = useRef<Promise<TurnCheck> | null>(null);
  // The first read of the conversation, which whatever reads it next must come after.
  const opening = useRef<Promise<unknown> | null>(null);

  /** What the events of a turn do to the page, whoever asked for the turn. */
  const applyTurnEvent = useCallback((event: ChatEvent, controller: AbortController) => {
    if (event.type === "start") {
      const real = event.user_message;
      if (!real) return;
      // A message said not to have gone turns out to be what is being written about.
      if (settleSending(id, [real]) && turnStore.failureOf(id) === "turn running") {
        turnStore.fail(id, null);
      }
      // In place of the one drawn when it was sent, and not added twice: a turn
      // can be read from its start more than once.
      setMessages((prev) => [
        ...prev.filter((m) => !m.id.startsWith("optimistic-") && m.id !== real.id),
        real,
      ].sort((a, b) => a.position - b.position));
    } else if (event.type === "delta") {
      turnStore.append(id, controller, event.text);
    } else if (event.type === "done") {
      // Never without a message from this version of the server, but an older one
      // sends one if the message was deleted, and this is no reason to fall over.
      const saved = event.message;
      if (!saved) return;
      setMessages((prev) => {
        const others = prev.filter((m) => m.id !== saved.id);
        return [...others, saved].sort((a, b) => a.position - b.position);
      });
      if (event.context) setContextStats(event.context);
      if (event.perf) setPerf(event.perf);
    } else if (event.type === "error") {
      // In the store, since the page that hears of it may not be the one on screen.
      turnStore.fail(id, { event });
    }
  }, [id]);

  /** Read a turn from its first word, which is where a reader starts. Says whether
   *  it saw the turn end, and how, and what broke the reading, if anything did. */
  const readTurn = useCallback(async (controller: AbortController, arriving: boolean) => {
    let failed = false;
    let ended = false;
    try {
      await data.turns.follow(id, (event) => {
        if (event.type === "start") {
          if (!arriving) turnStore.restart(id, controller);
          // A regeneration replaces a reply rather than adding one; without knowing
          // which, the page shows both the old reply and its replacement arriving
          // underneath, whoever asked for it. A continuation extends one, and what
          // was read of it on arriving has the new words in it already, but this
          // page's own copy of one it was already reading does not.
          if (arriving || event.mode !== "continue") setRegenTargetId(event.target_message_id ?? null);
        } else if (event.type === "error") {
          failed = true;
          ended = true;
        } else if (event.type === "done" || event.type === "discarded") {
          ended = true;
        }
        applyTurnEvent(event, controller);
      }, controller.signal);
      return { failed, ended };
    } catch (error) {
      return { failed, ended, broken: controller.signal.aborted ? undefined : error };
    }
  }, [id, applyTurnEvent]);

  const finishReading = useCallback((controller: AbortController) => {
    if (turnStore.end(id, controller)) setRegenTargetId(null);
  }, [id]);

  /** Read the conversation, and put it on screen unless the person has changed a
   *  message since the read was sent. Nearly always it says what is there already,
   *  and then that is left alone rather than every message being drawn twice. */
  const readAgain = useCallback(async () => {
    const changes = changesByHand.current;
    const sent = ++readsSent.current;
    const latest = (await inTime(data.conversations.get(id))).messages ?? [];
    settleSending(id, latest);
    return {
      latest,
      show() {
        if (changesByHand.current !== changes || readsSent.current !== sent) return;
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
      const before = turnStore.readerOf(id);
      // An answer takes a while, and it is about how things stood when it was asked.
      // If the person has stopped the turn since, or asked for another, it is out
      // of date, and acting on it would undo what they did.
      const outOfDate = () => turnStore.readerOf(id) !== before || turnStore.isStopping(id);
      let handedOver: AbortController | null = null;
      try {
        const state = await inTime(data.turns.state(id));
        if (outOfDate()) return { result: "superseded" };
        if (state.running) {
          const reader = new AbortController();
          turnStore.handOver(id, reader);
          turnStore.fail(id, null);
          void readToTheEnd(reader, false);
          return { result: "running" };
        }
        if (state.ended_recently) {
          // Nothing more can come of this one, so nothing further to ask, and no
          // reason for it to take long: nothing else can be asked in the meantime.
          const reader = new AbortController();
          handedOver = reader;
          turnStore.handOver(id, reader);
          turnStore.fail(id, null);
          const tooLong = setTimeout(() => turnStore.lose(id, reader, streamEndedEarly()), QUESTION_TIMEOUT_MS);
          const { failed, broken } = await readTurn(reader, false);
          clearTimeout(tooLong);
          if (broken !== undefined) {
            turnStore.lose(id, reader, broken);
            return { result: "unreachable" };
          }
          // Lost to the timer above, or replaced by a turn asked for meanwhile.
          if (turnStore.readerOf(id) !== reader) return { result: "superseded" };
          if (!turnStore.isRunning(id)) return { result: "unreachable" };
          if (failed) {
            // The failure is what the person is told. Nothing came of the turn, so
            // somebody asking again really is asking for something new.
            finishReading(handedOver);
            const { latest, show } = await readAgain();
            show();
            return { result: "no reply", messages: latest };
          }
        }

        const reader = turnStore.readerOf(id);
        const { latest, show } = await readAgain();
        if (turnStore.readerOf(id) !== reader || turnStore.isStopping(id)) {
          // A reader handed over here has nobody else to end it.
          if (handedOver) finishReading(handedOver);
          return { result: "superseded" };
        }
        show();
        turnStore.drop(id, reader);
        setRegenTargetId(null);

        const last = latest.at(-1);
        if (fingerprint(last) === lastAsked.current?.lastMessageBefore) {
          turnStore.fail(id, "no reply");
          return { result: "not sent", messages: latest };
        }
        if (last?.role !== "assistant") {
          // Quietly, if it was stopped before any word: that is what was asked for.
          turnStore.fail(id, unanswered(latest) ? "no reply" : null);
          return { result: "no reply", messages: latest };
        }
        turnStore.fail(id, null);
        return { result: "settled", messages: latest };
      } catch (error) {
        // A reader handed over here has nobody else to end it.
        if (handedOver) turnStore.lose(id, handedOver, error);
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
      if (turnStore.closedEarly(id, controller) >= CLOSES_WITHOUT_A_WORD) {
        turnStore.lose(id, controller, why);
        return;
      }
      const { result } = await checkOnTurn();
      if (result === "unreachable" && !controller.signal.aborted) turnStore.lose(id, controller, why);
    }

    /** Read a turn until it ends, whatever that takes. */
    async function readToTheEnd(reader: AbortController, arriving: boolean) {
      const { ended, broken } = await readTurn(reader, arriving);
      if (!ended) await pickTurnBackUp(reader, broken ?? streamEndedEarly());
      finishReading(reader);
    }

    return { checkOnTurn, pickTurnBackUp, readToTheEnd };
  }, [id, readTurn, finishReading, readAgain]);

  /** A turn is worth asking about if it was cut off, or if it has gone quiet. If the
   *  server is out of reach, one cut off stays as it is, and one that had gone quiet
   *  now says so. */
  const askIfWorthIt = useCallback(() => {
    const here = turnStore.read(id);
    if (!here || (here.busy && turnStore.quietFor(id) < QUIET_BEFORE_ASKING_MS)) return;
    const reader = turnStore.readerOf(id);
    void checkOnTurn().then(({ result }) => {
      if (result === "unreachable" && reader) turnStore.lose(id, reader, streamEndedEarly());
    });
  }, [id, checkOnTurn]);

  /** Fetch the conversation again, after the first read if that is still on its way:
   *  coming back to a reply just as it ends, what that read says is out of date. */
  const reload = useCallback(
    () =>
      Promise.resolve(opening.current)
        .catch(() => {})
        .then(readAgain)
        .then(({ show }) => show())
        .catch(() => {}), // keep current state
    [readAgain],
  );

  // A phone coming back. Sleeping is when a connection goes, sometimes with an
  // error that came too soon to do anything about, and sometimes without one: a
  // stream can simply stop. Each event is worth one question, and only if there is
  // something to ask.
  useEffect(() => {
    let waiting: ReturnType<typeof setTimeout> | undefined;
    const ask = () => {
      void turnStore.sayStopAgain(id).then((said) => {
        if (said) void reload();
      });
      askIfWorthIt();
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
  }, [id, askIfWorthIt, reload]);

  useEffect(() => {
    const controller = new AbortController();
    const firstRead = data.conversations.get(id);
    opening.current = firstRead;
    firstRead
      .then((convo) => {
        // Before the box appears, which has nothing to offer of what this finds.
        settleSending(id, convo.messages ?? []);
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

    /** A reply that failed with no page open to say so. Unless something more exact
     *  is known about it, or another device has just started on it: the conversation
     *  and the state of the turn are two reads, and one that came first says nothing
     *  about what happened in between. */
    async function reportIfUnanswered(messages: Message[]) {
      if (!unanswered(messages)) {
        if (turnStore.failureOf(id) === "no reply") turnStore.fail(id, null);
        return;
      }
      const known = turnStore.failureOf(id);
      if (known && known !== "turn running") return;
      const again = await inTime(data.turns.state(id));
      if (controller.signal.aborted || turnStore.isRunning(id)) return;
      if (again.running) void checkOnTurn();
      else turnStore.fail(id, "no reply");
    }

    void (async () => {
      void turnStore.sayStopAgain(id);
      if (turnStore.isRunning(id)) {
        // This page is already the one running it, if its reader is still alive after
        // whatever happened while the person was elsewhere.
        askIfWorthIt();
        return;
      }
      // Left from a reply cut off before the person went elsewhere. They are back
      // at the start, and it will be read like everything else.
      turnStore.drop(id, turnStore.readerOf(id));
      const state = await data.turns.state(id);
      if (controller.signal.aborted) return;
      if (state.running) {
        // Watch a reply that is being written elsewhere — by a server that carried
        // on after the phone that asked for it went to sleep.
        turnStore.begin(id, controller);
        turnStore.fail(id, null);
        await readToTheEnd(controller, true);
      } else if (!state.ended_recently) {
        await reportIfUnanswered((await firstRead).messages ?? []);
        return;
      }
      // The conversation and the state of the turn are two reads, not one moment.
      // A turn that ended between them leaves a reply as far as it had got, with
      // no turn to watch and so nothing coming to replace it. What was read cannot
      // say so, since only a new reply is marked while it is written, but the
      // server can. The same goes for a read still on its way when the turn this
      // page attached to ended. Once more is enough: nothing was running when this
      // is asked for.
      await firstRead;
      if (controller.signal.aborted) return;
      const { latest, show } = await readAgain();
      if (controller.signal.aborted || turnStore.isRunning(id)) return;
      show();
      if (!state.running) await reportIfUnanswered(latest);
    })().catch(() => {
      /* whatever was read first stays on screen, or its failure is reported above */
    });

    return () => controller.abort();
  }, [id, readToTheEnd, readAgain, checkOnTurn, askIfWorthIt]);

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
    clientId?: string,
  ) {
    if (!conversation || busy) return;
    turnStore.fail(id, null);
    stickToBottom.current = true;
    const controller = new AbortController();
    setBeforeTurn(new Set(known.map((m) => m.id)));
    turnStore.begin(conversation.id, controller);
    lastAsked.current = { mode, content, messageMode, lastMessageBefore: fingerprint(known.at(-1)) };

    // The sent message appears instantly; the persisted version from the
    // `start` event replaces it (or it is rolled back if nothing was saved).
    const alreadyThere = clientId !== undefined && known.some((m) => m.meta?.client_id === clientId);
    const optimisticId = mode === "send" && !alreadyThere ? `optimistic-${Date.now()}` : null;
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

    /** A message whose turn did not begin is still the person's, whatever got in the
     *  way, and is theirs to send again. If it did reach the server, and it was only
     *  the answer that was lost, the conversation will say so: see `settleSending`. */
    const giveBackIfNotBegun = () => {
      if (clientId && !startReceived) giveBack(conversation.id, clientId);
    };

    if (mode === "regenerate") {
      const last = known[known.length - 1];
      setRegenTargetId(last?.role === "assistant" ? last.id : null);
    } else {
      setRegenTargetId(null);
    }

    let finished = false;
    let wrote = false;
    let toldOfAReply = false;

    const onEvent = (event: ChatEvent) => {
      if (event.type === "start") {
        startReceived = true;
        if (clientId) forgetSending(conversation.id, clientId);
        if (!conversation.title && content && messageMode === "say") {
          setConversation((c) => (c ? { ...c, title: content.slice(0, 60) } : c));
        }
      } else if (event.type === "delta") {
        wrote = true;
      } else if (event.type === "done" || event.type === "error" || event.type === "discarded") {
        finished = true;
        toldOfAReply = event.type !== "error" && !wrote;
      }
      applyTurnEvent(event, controller);
    };

    try {
      await data.turns.send(
        { conversation_id: conversation.id, mode, content, message_mode: messageMode, client_id: clientId },
        onEvent,
        controller.signal,
      );
      giveBackIfNotBegun(); // an error instead of a beginning, or nothing at all
      if (!finished) {
        // Stream closed without done/error. Stopped somewhere else, or given up on
        // by something between here and the server, which is no end to the turn.
        await pickTurnBackUp(controller, streamEndedEarly());
      }
    } catch (e) {
      giveBackIfNotBegun();
      if (controller.signal.aborted) {
        // Stopped, and what this reads may not yet be all that arrived: `stop` reads
        // again once the server has finished. Or it was only this connection that was
        // given up on, for another reader, in which case there is nothing to do.
        if (turnStore.isRunning(id) && turnStore.readerOf(id) === controller) await reload();
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
        turnStore.lose(id, controller, e);
      } else if (e instanceof DataError && e.kind === "turn_running") {
        // One is being written already, and it is not this. Nothing was saved of
        // what was asked. Show the one there is, and say why this did not go.
        lastAsked.current = null;
        await checkOnTurn();
        turnStore.fail(id, "turn running");
      } else if (clientId) {
        // Evermind answered, and said no. Or something on the way to it did, after
        // passing the message on, which only the conversation can say. Then there is
        // nothing to report, and perhaps a reply to read. If one is being written, that
        // is either this message's, which its first word will say, or the reason it failed.
        const { result } = await checkOnTurn();
        if (result === "running") turnStore.fail(id, "turn running");
        else if (isSending(id, clientId)) turnStore.fail(id, { error: e });
      } else {
        // Evermind answered, and said no.
        await reload();
        turnStore.fail(id, { error: e });
      }
    }

    // Transport died or the turn failed before anything was persisted:
    // withdraw the optimistic bubble so the display matches the server.
    if (optimisticId && !startReceived) {
      setMessages((prev) => prev.filter((m) => m.id !== optimisticId));
    }

    finishReading(controller);

    // Told of a reply from before instead of given one, by a server that has no reason
    // to mention that it is writing something else, for someone else.
    if (clientId && toldOfAReply) void checkOnTurn();
  }

  /** The server is asked something on the person's behalf, who cannot send anything
   *  until it answers. Answering can take a while, and whatever is sent meanwhile would
   *  overlap with what is waiting for this, which has only one place to come back to. */
  async function askFirst() {
    turnStore.setAsking(id, true);
    try {
      return await checkOnTurn();
    } finally {
      turnStore.setAsking(id, false);
    }
  }

  /** A message from the box. If the last reply was cut off, the server may well still
   *  be writing it, and is asked first, since it would refuse this anyway. If it
   *  cannot be reached, nothing is lost by the message going back where it was. */
  async function sendMessage(content: string, messageMode: "say" | "narrate" | "ooc") {
    const clientId = beginSending(id, content, messageMode);
    let known = messages;
    if (cutOff) {
      const check = await askFirst();
      if (check.result === "running") turnStore.fail(id, "turn running");
      if (!("messages" in check)) {
        giveBack(id, clientId);
        return;
      }
      known = check.messages;
    }
    await deliver(clientId, content, messageMode, known);
  }

  /** Sends a message, which the conversation may already have. With something after
   *  it, its reply, there is nothing to ask for. Without, what is asked for is the reply:
   *  the server knows the message by its id, and adds nothing. */
  async function deliver(clientId: string, content: string, messageMode: "say" | "narrate" | "ooc", known: Message[]) {
    const at = known.findIndex((m) => m.meta?.client_id === clientId);
    if (at === -1 || at === known.length - 1) await runTurn("send", content, messageMode, known, clientId);
  }

  /** Words written just before the stop may have reached only the server until now,
   *  and the read that came with the end of the reader knows nothing of them. */
  async function stop() {
    if (await turnStore.stop(id)) await reload();
  }

  /** Trying again after a connection was lost asks first: the reply may be being
   *  written, or be there already, and asking for it again would make another. */
  async function retry() {
    // What was reported is a stop that could not be said, and that is what to retry.
    if (turnStore.hasStopToSay(id)) {
      if (await turnStore.sayStopAgain(id)) await reload();
      return;
    }
    const asked = lastAsked.current;
    // The message that went back to the box is what is being reported, unless something
    // else has been asked for since. Rewritten or emptied since, it is the person's to
    // do something else with, and all that is left of it is that it was refused.
    const refused = !asked || asked.mode === "send" ? givenBack(id) : null;
    if (refused && stillInBox(id, refused)) {
      await retryMessage(refused);
      return;
    }
    if (refused) forgetSending(id, refused.clientId);

    let known = messages;
    let nothingLost = refused !== null;
    if (cutOff || failure === "no reply") {
      if (checking.current) return;
      const check = await askFirst();
      if (!("messages" in check) || check.result === "settled") return;
      known = check.messages;
      // Sent, and gone again since, or the same message this reports as refused.
      nothingLost ||= check.result === "not sent" && asked?.mode === "send";
    }
    // With the person's message last, asking for a new version is asking for its reply,
    // which is always worth asking for. With a reply last, a refused message is no reason
    // to replace it.
    const answered = known.at(-1)?.role !== "user";
    if (answered && nothingLost) turnStore.fail(id, null);
    else await runTurn(answered && asked?.mode === "continue" ? "continue" : "regenerate", undefined, "say", known);
  }

  /** A message that went back to the box. Whether it arrived decides, and what became
   *  of the turn does not: one that failed may be for this message or for another. It
   *  never asks for a new version of the reply before it, which is not what is wrong,
   *  and which would leave the message unsent. What has been typed under it stays. */
  async function retryMessage(message: Sending) {
    if (checking.current) return;
    const check = await askFirst();
    if (!("messages" in check)) return;
    const arrived = check.messages.some((m) => m.meta?.client_id === message.clientId);
    if (arrived || sendAgain(id, message)) {
      await deliver(message.clientId, message.text, message.mode, check.messages);
    } else {
      turnStore.fail(id, null); // rewritten or emptied while the answer was on its way
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
    // The server takes the memory back with the story: the facts drawn from the turns
    // that went, and a summary that described them. What the side panel shows is from
    // before, and saving the summary it shows would put the old one back. With no
    // summary on screen there is nothing to be wrong about.
    setStoryCuts((n) => n + 1);
    if (conversation?.summary) {
      data.conversations
        .get(id)
        .then(({ summary }) => setConversation((c) => (c ? { ...c, summary } : c)))
        .catch(() => {});
    }
    // Whatever was being reported was about what has just gone.
    turnStore.fail(id, null);
    if (cutOff) {
      turnStore.drop(id, turnStore.readerOf(id));
      setRegenTargetId(null);
    }
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
    ? describeError(turn.lost, t, t("chat.errors.connectionFailed"))
    : failure === null || silent
      ? null
      : failure === "no reply"
        ? t("chat.errors.noReply")
        : failure === "turn running"
          // Only as long as that is true: there is nothing to say once it has ended.
          ? (busy ? t("errors.turnRunning") : null)
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
                <ModelSilent onRetry={retry} />
              </div>
            )}

            {problem && (
              <div className="mx-1 my-3 flex items-center justify-between gap-4 rounded-xl border border-blood/40 bg-blood/10 px-4 py-3">
                <p className="text-sm text-blood">{problem}</p>
                {lastMessage && !busy && !asking && (
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
          onSend={sendMessage}
          onStop={stop}
          busy={busy || asking}
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
