import { data, DataError, type Asking } from "@/data";
import type { TurnState } from "@/types";
import { useCallback, useEffect, useRef, useState } from "react";

export const PATIENCE_MS = 10_000;
const AFTER_A_FAILURE_MS = 2_000;
const AFTER_A_CLOSE_MS = 1_000;
/** `online` and `visibilitychange` tend to arrive together as a phone wakes. */
const WAKING_MS = 200;

export type Outcome = Extract<TurnState, { running: false }>["outcome"];

/** The answer, or a failure if it takes too long: a connection that died in silence never answers. */
export function inTime<T>(question: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DataError("No answer in time.", { kind: "network" })), PATIENCE_MS);
  });
  return Promise.race([question, late]).finally(() => clearTimeout(timer));
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

// Conversations whose turn was asked for from a page, which is where how it ended is said.
const asked = new Set<string>();

/** The reply being written: ask the server how it stands, read, follow the words until that ends
 *  for any reason, ask again. `read` fetches the conversation and hands back what shows it, which
 *  says whether it did. */
export function useTurn(id: string, read: (asking: Asking) => Promise<() => boolean>) {
  // The message being written, "" until the server says which.
  const [writing, setWriting] = useState<string | null>(null);
  const [lost, setLost] = useState<unknown>(null);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const [text] = useState(() => new LiveText());
  const watching = useRef<AbortController | null>(null);
  // The same, and whether what is on screen may be behind the server: a phone waking to nothing new
  // reads nothing, which the side panel counts on.
  const shown = useRef({ writing: null as string | null, behind: true });

  const watch = useCallback(async () => {
    watching.current?.abort();
    const reader = new AbortController();
    watching.current = reader;
    const { signal } = reader;
    const asking = { signal, within: PATIENCE_MS };
    while (!signal.aborted) {
      const started = Date.now();
      try {
        const state = await data.turns.state(id, asking);
        if (signal.aborted) return;
        if (shown.current.behind || (state.running ? state.message_id : null) !== shown.current.writing) {
          const show = await read(asking);
          if (signal.aborted) return;
          // Older than a change made by hand meanwhile, it is not shown, and another is sent.
          if (!show()) continue;
          shown.current.behind = false;
        }
        setLost(null);
        if (!state.running) {
          shown.current.writing = null;
          setWriting(null);
          text.set("");
          // How the turn this page asked for ended, while the server keeps it: a newer turn ends that.
          if (asked.delete(id) || !state.outcome) setOutcome(state.outcome);
          return;
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
        shown.current.behind = true;
        setLost(error);
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
    let waking = setTimeout(watch);
    const comingBack = () => {
      if (document.visibilityState !== "visible") return;
      clearTimeout(waking);
      waking = setTimeout(watch, WAKING_MS);
    };
    window.addEventListener("online", comingBack);
    document.addEventListener("visibilitychange", comingBack);
    return () => {
      clearTimeout(waking);
      watching.current?.abort();
      window.removeEventListener("online", comingBack);
      document.removeEventListener("visibilitychange", comingBack);
    };
  }, [watch]);

  return { writing, text, lost, outcome, watch, began, recheck, noAnswer, forget: () => setOutcome(null) };
}
