import { data, DataError, type Asking, type TurnRequest } from "@/data";
import { arrived, loadSending, settleSending } from "@/lib/drafts";
import type { Conversation, Message, TurnState } from "@/types";
import { useCallback, useEffect, useRef, useState } from "react";

const PATIENCE_MS = 10_000;
const AFTER_A_FAILURE_MS = 2_000;
const AFTER_A_CLOSE_MS = 1_000;
/** `online` and `visibilitychange` tend to arrive together as a phone wakes. */
const WAKING_MS = 200;
/** Failures kept quiet on waking with nothing under way, while the network comes back. */
const QUIET_FAILURES = 2;

export type Outcome = Extract<TurnState, { running: false }>["outcome"];

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** No answer came, which says nothing of whether what was asked for arrived. */
const unanswered = (error: unknown) =>
  error instanceof DataError && (error.kind === "network" || error.kind === "offline");

/** A message that got no answer, and that the server, answering since, does not have. */
const NOT_SENT = new DataError("This message was not sent.", { kind: "not_sent" });

/** The words of the reply being written, for the one thing on screen that follows them. */
export class LiveText {
  private text = "";
  private listeners = new Set<() => void>();
  get = () => this.text;
  set(text: string) {
    this.text = text;
    this.listeners.forEach((listener) => listener());
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
}

type Answer = { request: TurnRequest } & ({ message: Message | null } | { error: unknown });

// Conversations whose turn was asked for from a page, which is where how it ended is said.
const asked = new Set<string>();
// Requests for a turn not answered yet, by conversation: one may still arrive.
const waiting = new Map<string, number>();
// The page showing each conversation, which hears the answers to what was asked for there.
const pages = new Map<string, (answer: Answer) => void>();
// Each conversation's message on its way, until it is answered or patience runs out.
const sending = new Map<string, Promise<void>>();

/** A message sent from a page left since, while it is on its way. */
export const onItsWay = (id: string) => sending.get(id);

/** Its answer, however late, goes to the page showing the conversation then; settles at it or at patience's end. */
function askFor(id: string, request: TurnRequest): Promise<void> {
  waiting.set(id, (waiting.get(id) ?? 0) + 1);
  let answered = false;
  let gaveUp = false;
  const tell = (answer: Answer) => pages.get(id)?.(answer);
  // A read found its message: it got there, whatever becomes of the request.
  const found = () => !!request.client_id && loadSending(id)?.clientId !== request.client_id;
  const answer = data.turns.start(request).then(
    ({ user_message }) => {
      if (request.client_id) arrived(id, request.client_id);
      asked.add(id);
      return { request, message: user_message };
    },
    (error: unknown) => ({ request, error }),
  ).then((answer) => {
    answered = true;
    const left = (waiting.get(id) ?? 1) - 1;
    if (left) waiting.set(id, left);
    else waiting.delete(id);
    // Unanswered still: no more is known than when patience ran out.
    if (!("error" in answer && (found() || (gaveUp && unanswered(answer.error))))) tell(answer);
  });
  const patience = pause(PATIENCE_MS).then(() => {
    if (answered || found()) return;
    gaveUp = true;
    tell({ request, error: new DataError("No answer in time.", { kind: "network" }) });
  });
  const settled = Promise.race([answer, patience]);
  if (request.mode === "send") {
    sending.set(id, settled);
    void settled.then(() => {
      if (sending.get(id) === settled) sending.delete(id);
    });
  }
  return settled;
}

/** The reply being written: ask the server how it stands, read when what is shown may be behind,
 *  follow the words until that ends for any reason, ask again. `read` fetches the conversation
 *  with what shows it, which says whether it did; `add` shows a message the server has taken. */
export function useTurn(
  id: string,
  read: (asking: Asking) => Promise<{ conversation: Conversation; show: () => boolean }>,
  add: (message: Message) => void,
) {
  // The message being written, "" until the server says which.
  const [writing, setWriting] = useState<string | null>(null);
  const [lost, setLost] = useState<unknown>(null);
  const [outcome, setOutcome] = useState<Outcome>(null);
  // What the server said no to, or could not be reached for, when a turn was last asked for.
  const [refused, setRefused] = useState<unknown>(null);
  const [text] = useState(() => new LiveText());
  const watching = useRef<AbortController | null>(null);
  // The same, the revision of what is on screen, and whether it may be behind the server.
  const shown = useRef({ writing: null as string | null, revision: null as number | null, behind: true });
  // Until when a message on its way that no request here waits for, sent before a reload say, may land.
  const unsure = useRef(0);
  const adding = useRef(add);
  useEffect(() => {
    adding.current = add;
  });

  const watch = useCallback(async (quietly = false) => {
    watching.current?.abort();
    const reader = new AbortController();
    watching.current = reader;
    const { signal } = reader;
    const asking = { signal, within: PATIENCE_MS };
    let quiet = quietly ? QUIET_FAILURES : 0;
    while (!signal.aborted) {
      const started = Date.now();
      try {
        const state = await data.turns.state(id, asking);
        if (signal.aborted) return;
        const now = state.running ? state.message_id : null;
        if (shown.current.behind || now !== shown.current.writing
          || (!state.running && state.revision !== shown.current.revision)) {
          const { conversation, show } = await read(asking);
          if (signal.aborted) return;
          // Older than a change made by hand meanwhile, it is not shown, and another is sent.
          if (!show()) continue;
          shown.current.behind = false;
          shown.current.revision = conversation.revision ?? null;
          if (settleSending(id, conversation.messages ?? [])) {
            asked.add(id);
            setRefused(null);
          }
          // Newer than the state: something began or ended in between, which it says next.
          if (!state.running && shown.current.revision !== state.revision) continue;
        }
        quiet = 0;
        setLost(null);
        setRefused((refusal: unknown) => (unanswered(refusal) ? NOT_SENT : refusal));
        if (!state.running) {
          shown.current.writing = null;
          setWriting(null);
          text.set("");
          // How the turn this page asked for ended, while the server keeps it: a newer turn ends that.
          if (asked.delete(id) || !state.outcome) setOutcome(state.outcome);
          if (!waiting.has(id) && !(Date.now() < unsure.current && loadSending(id))) return;
          await pause(AFTER_A_FAILURE_MS); // what was asked for may arrive yet
          continue;
        }
        setOutcome(null);
        text.set(state.text);
        shown.current.writing = state.message_id;
        setWriting(state.message_id);
        let ended = false;
        // A stream that breaks is no failure: whether the server can be reached is asked next.
        await data.turns.follow(id, (event) => {
          if ("end" in event) ended = true;
          else text.set("text" in event ? event.text : text.get() + event.delta);
        }, signal).catch(() => {});
        if (signal.aborted) return;
        // Given up on by something between here and the server, which is no end to the turn.
        if (!ended) await pause(AFTER_A_CLOSE_MS);
      } catch (error) {
        if (signal.aborted) return;
        if (quiet > 0) quiet -= 1;
        else setLost(error);
        await pause(AFTER_A_FAILURE_MS - (Date.now() - started));
      }
    }
  }, [id, read, text]);

  /** The server has what this page asked for: how it ends is said here. */
  const began = useCallback(() => {
    asked.add(id);
    setOutcome(null);
    if (shown.current.writing === null) {
      shown.current.writing = "";
      setWriting("");
    }
    void watch();
  }, [id, watch]);

  /** Something asked for did not begin, or may not have. */
  const recheck = useCallback(() => {
    shown.current.behind = true;
    void watch();
  }, [watch]);

  /** No answer came: what was asked for may be under way all the same, and how it ends is said here. */
  const noAnswer = useCallback((error: unknown) => {
    asked.add(id);
    setLost(error);
    recheck();
  }, [id, recheck]);

  useEffect(() => {
    const hear = (answer: Answer) => {
      if ("message" in answer) {
        setRefused(null);
        if (answer.message) adding.current(answer.message);
        began();
      } else if (answer.request.mode !== "send" && unanswered(answer.error)) noAnswer(answer.error);
      else {
        setRefused(answer.error);
        recheck();
      }
    };
    pages.set(id, hear);
    return () => {
      if (pages.get(id) === hear) pages.delete(id);
    };
  }, [id, began, noAnswer, recheck]);

  useEffect(() => {
    unsure.current = loadSending(id) ? Date.now() + PATIENCE_MS : 0;
    let waking = setTimeout(watch);
    const comingBack = () => {
      if (document.visibilityState !== "visible") return;
      clearTimeout(waking);
      waking = setTimeout(() => watch(shown.current.writing === null && !waiting.has(id)), WAKING_MS);
    };
    window.addEventListener("online", comingBack);
    document.addEventListener("visibilitychange", comingBack);
    return () => {
      clearTimeout(waking);
      watching.current?.abort();
      window.removeEventListener("online", comingBack);
      document.removeEventListener("visibilitychange", comingBack);
    };
  }, [id, watch]);

  /** Asks for a turn, whose answer this page, or the one showing the conversation by then, hears. */
  const ask = useCallback((request: Omit<TurnRequest, "conversation_id">) => {
    setRefused(null);
    setOutcome(null);
    return askFor(id, { conversation_id: id, ...request });
  }, [id]);

  /** The server answers once what arrived is saved. */
  const stop = useCallback(async () => {
    setRefused(null);
    try {
      await data.turns.stop(id, { within: PATIENCE_MS });
      void watch();
    } catch (error) {
      noAnswer(error);
    }
  }, [id, watch, noAnswer]);

  const forget = useCallback(() => {
    setOutcome(null);
    setRefused(null);
  }, []);

  return { writing, text, lost, outcome, refused, ask, stop, forget };
}
