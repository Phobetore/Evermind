/** The turns in flight, kept outside React.
 *
 *  The streaming state used to live in the conversation page, so leaving the
 *  page threw it away: the reply kept arriving, nothing was lost, but there was
 *  no longer anything on screen saying so, and coming back showed a silent
 *  conversation with no sign that the character was still writing.
 *
 *  A module-level store survives the unmount that page state does not. The page
 *  reads it through useSyncExternalStore and can leave and return at will. Each
 *  conversation has a turn of its own: a reply can be left arriving in one while
 *  another is asked for in the next.
 *
 *  A turn is read through one connection at a time, its reader, known by the
 *  controller that can abort it. The turn itself is the server's and outlives any
 *  of them, so a reader can break, or go quiet, and be replaced. Only the reader
 *  holding a turn can change it: one that has been replaced has no say.
 */

import { data } from "@/data";
import type { ChatEvent } from "@/types";

export interface Turn {
  conversationId: string;
  text: string;
  /** Still receiving. True until `lose`; `end` drops the turn altogether. */
  busy: boolean;
  /** Why it stopped receiving, once it has: the connection was lost, and the words
   *  that had arrived stay here until something better takes their place. */
  lost: unknown;
}

/** What went wrong with the last turn of a conversation. Kept here for the same
 *  reason as the turn: the page that hears of it may not be the one on screen, which
 *  has to say so all the same. Described when drawn, so that a change of language
 *  reaches the sentence too. */
export type TurnFailure =
  | { event: Extract<ChatEvent, { type: "error" }> }
  | { error: unknown }
  | "no reply"
  | "turn running"
  /** A continuation that did not change the reply. */
  | "nothing added";

interface HeldTurn extends Turn {
  controller: AbortController;
  lastWordAt: number;
  /** Being read from its first word again: what has come back so far, kept aside
   *  until it has caught up with what is on screen, which never goes backwards. */
  replay: string | null;
  /** Readers in a row that ended with the turn unfinished and no new word. */
  closes: number;
  textAtLastClose: number;
  /** The person has asked for it to stop. */
  stopping: boolean;
}

const turns = new Map<string, HeldTurn>();
const failures = new Map<string, TurnFailure>();
/** A stop that could not be said, and the failure that reports it, to say it again. */
const stopsToSay = new Map<string, TurnFailure>();
/** How many turns have begun, for knowing a stop was about one that has gone. */
const begun = new Map<string, number>();
/** Conversations where the person is waiting on a question about the turn. */
const asking = new Set<string>();
const listeners = new Set<() => void>();

// A new object on every change and the same one otherwise: useSyncExternalStore
// compares by identity and would loop forever on a fresh object each read.
const snapshots = new Map<string, Turn>();

function publish(conversationId: string) {
  const turn = turns.get(conversationId);
  if (turn) {
    snapshots.set(conversationId, {
      conversationId, text: turn.text, busy: turn.busy, lost: turn.lost,
    });
  } else {
    snapshots.delete(conversationId);
  }
  for (const listener of listeners) listener();
}

function held(conversationId: string, controller: AbortController) {
  const turn = turns.get(conversationId);
  return turn?.controller === controller ? turn : undefined;
}

function sayStop(conversationId: string) {
  const asOf = begun.get(conversationId);
  return data.turns.stop(conversationId).then(
    () => {
      const reported = stopsToSay.get(conversationId);
      stopsToSay.delete(conversationId);
      if (reported && failures.get(conversationId) === reported) {
        failures.delete(conversationId);
        publish(conversationId);
      }
      return true;
    },
    (error: unknown) => {
      // The next turn has begun meanwhile, and a stop said again would land on that.
      if (begun.get(conversationId) !== asOf) return false;
      const failure = { error };
      stopsToSay.set(conversationId, failure);
      failures.set(conversationId, failure);
      publish(conversationId);
      return false;
    },
  );
}

export const turnStore = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },

  read: (conversationId: string) => snapshots.get(conversationId) ?? null,

  failureOf: (conversationId: string) => failures.get(conversationId) ?? null,

  fail(conversationId: string, failure: TurnFailure | null) {
    if (failure) failures.set(conversationId, failure);
    else failures.delete(conversationId);
    publish(conversationId);
  },

  begin(conversationId: string, controller: AbortController) {
    const replaced = turns.get(conversationId)?.controller;
    // A stop still to be said was for a turn that has been left behind by now, and
    // must not land on this one.
    stopsToSay.delete(conversationId);
    begun.set(conversationId, (begun.get(conversationId) ?? 0) + 1);
    turns.set(conversationId, {
      conversationId, text: "", busy: true, lost: null, controller, lastWordAt: Date.now(),
      replay: null, closes: 0, textAtLastClose: 0, stopping: false,
    });
    publish(conversationId);
    if (replaced !== controller) replaced?.abort();
  },

  /** A new reader takes over the turn, and the one it replaces is stopped. */
  handOver(conversationId: string, controller: AbortController) {
    const turn = turns.get(conversationId);
    if (!turn) {
      turnStore.begin(conversationId, controller);
      return;
    }
    const replaced = turn.controller;
    turns.set(conversationId, {
      ...turn, busy: true, lost: null, controller, lastWordAt: Date.now(),
    });
    publish(conversationId);
    replaced.abort();
  },

  /** This reader is at the first word again, which is where every reader starts. */
  restart(conversationId: string, controller: AbortController) {
    const turn = held(conversationId, controller);
    if (turn) turns.set(conversationId, { ...turn, replay: "" });
  },

  append(conversationId: string, controller: AbortController, text: string) {
    const turn = held(conversationId, controller);
    if (!turn) return;
    if (turn.replay === null) {
      turns.set(conversationId, { ...turn, text: turn.text + text, lastWordAt: Date.now() });
    } else {
      const replay = turn.replay + text;
      turns.set(conversationId, replay.length < turn.text.length
        ? { ...turn, replay, lastWordAt: Date.now() }
        : { ...turn, text: replay, replay: null, lastWordAt: Date.now() });
    }
    publish(conversationId);
  },

  /** A reader ended with the turn unfinished. Says how many have, in a row, without
   *  a new word to show for it. */
  closedEarly(conversationId: string, controller: AbortController) {
    const turn = held(conversationId, controller);
    if (!turn) return 0;
    const closes = turn.text.length > turn.textAtLastClose ? 1 : turn.closes + 1;
    turns.set(conversationId, { ...turn, closes, textAtLastClose: turn.text.length });
    return closes;
  },

  /** This reader's turn is over, whether it landed, failed or was stopped. Says
   *  whether that ended anything: a reader that was replaced, or that lost its
   *  connection, ends nothing. */
  end(conversationId: string, controller: AbortController) {
    if (!held(conversationId, controller)?.busy) return false;
    turns.delete(conversationId);
    publish(conversationId);
    return true;
  },

  /** This reader's connection is gone and could not be replaced. The turn is not
   *  over as far as anyone knows, so what has arrived stays on screen. Nothing more
   *  is taken from the reader, if there was any life left in it. */
  lose(conversationId: string, controller: AbortController, why: unknown) {
    const turn = held(conversationId, controller);
    if (!turn?.busy) return;
    turns.set(conversationId, { ...turn, busy: false, lost: why, closes: 0, textAtLastClose: 0 });
    publish(conversationId);
    controller.abort();
  },

  /** Enough is known without this reader, whose turn and words are dropped. */
  drop(conversationId: string, controller: AbortController | null) {
    if (!controller || !held(conversationId, controller)) return;
    turns.delete(conversationId);
    publish(conversationId);
    controller.abort();
  },

  /** The person has asked for something that needs a question about the turn answered
   *  first. Nothing else can be sent until it is, from this page or from the same
   *  conversation opened again meanwhile: only one message can be on its way at once. */
  setAsking(conversationId: string, waiting: boolean) {
    if (waiting) asking.add(conversationId);
    else asking.delete(conversationId);
    publish(conversationId);
  },

  isAsking: (conversationId: string) => asking.has(conversationId),

  /** Whichever reader holds this conversation's turn, if any. */
  readerOf(conversationId: string) {
    return turns.get(conversationId)?.controller ?? null;
  },

  /** How long the turn has gone without a word. */
  quietFor(conversationId: string) {
    const turn = turns.get(conversationId);
    return turn ? Date.now() - turn.lastWordAt : 0;
  },

  /** Stop the turn from anywhere, including a page that was not there when it
   *  started.
   *
   *  Hanging up is no longer enough. The reply is generated by the server now,
   *  so that closing a tab does not end it — which also means that dropping the
   *  connection cannot be read as "stop", because it is exactly what a phone
   *  going to sleep does. Stopping has to be said, and if it cannot be, that is
   *  reported, and it is said again when the connection returns.
   *
   *  Says whether it got through. The server answers once the turn has ended and all
   *  that arrived is in the conversation, or after ten seconds if it still has not. */
  stop(conversationId: string) {
    const turn = turns.get(conversationId);
    if (!turn) return Promise.resolve(false);
    if (turn.busy) {
      turns.set(conversationId, { ...turn, stopping: true });
    } else {
      // Cut off already, with no reader to end it and take the mark away with it.
      turns.delete(conversationId);
      publish(conversationId);
    }
    turn.controller.abort();
    return sayStop(conversationId);
  },

  /** Whether the person has asked for this conversation's turn to stop. */
  isStopping(conversationId: string) {
    return turns.get(conversationId)?.stopping ?? false;
  },

  /** Whether a stop is still to be said. */
  hasStopToSay(conversationId: string) {
    return stopsToSay.has(conversationId);
  },

  /** Says a stop again if it could not be said before. Says whether one got through. */
  async sayStopAgain(conversationId: string) {
    return stopsToSay.has(conversationId) ? sayStop(conversationId) : false;
  },

  isRunning(conversationId: string) {
    return turns.get(conversationId)?.busy ?? false;
  },
};
