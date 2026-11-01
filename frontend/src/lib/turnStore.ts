/** The turn in flight, kept outside React.
 *
 *  The streaming state used to live in the conversation page, so leaving the
 *  page threw it away: the reply kept arriving, nothing was lost, but there was
 *  no longer anything on screen saying so, and coming back showed a silent
 *  conversation with no sign that the character was still writing.
 *
 *  A module-level store survives the unmount that page state does not. The page
 *  reads it through useSyncExternalStore and can leave and return at will.
 *  Only one turn runs at a time, which is what the interface allows anyway.
 *
 *  A turn is read through one connection at a time, its reader, known by the
 *  controller that can abort it. The turn itself is the server's and outlives any
 *  of them, so a reader can break, or go quiet, and be replaced.
 */

import { data } from "@/data";

export interface Turn {
  conversationId: string;
  text: string;
  /** Still receiving. True until `lose`; `end` drops the turn altogether. */
  busy: boolean;
  /** Why it stopped receiving, once it has: the connection was lost, and the words
   *  that had arrived stay here until something better takes their place. */
  lost: unknown;
}

let current: (Turn & {
  controller: AbortController;
  lastWordAt: number;
  /** Being read from its first word again: what has come back so far, kept aside
   *  until it has caught up with what is on screen, which never goes backwards. */
  replay: string | null;
  /** Readers in a row that ended with the turn unfinished and no new word. */
  closes: number;
  textAtLastClose: number;
}) | null = null;
const listeners = new Set<() => void>();

// A new object on every change and the same one otherwise: useSyncExternalStore
// compares by identity and would loop forever on a fresh object each read.
let snapshot: Turn | null = null;

function publish() {
  snapshot = current
    ? {
        conversationId: current.conversationId,
        text: current.text,
        busy: current.busy,
        lost: current.lost,
      }
    : null;
  for (const listener of listeners) listener();
}

export const turnStore = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },

  read: () => snapshot,

  begin(conversationId: string, controller: AbortController) {
    current = {
      conversationId, text: "", busy: true, lost: null, controller, lastWordAt: Date.now(),
      replay: null, closes: 0, textAtLastClose: 0,
    };
    publish();
  },

  /** A new reader takes over the turn, and the one it replaces is stopped. */
  handOver(conversationId: string, controller: AbortController) {
    if (current?.conversationId !== conversationId) {
      turnStore.begin(conversationId, controller);
      return;
    }
    const replaced = current.controller;
    current = { ...current, busy: true, lost: null, controller, lastWordAt: Date.now() };
    publish();
    replaced.abort();
  },

  /** This reader is at the first word again, which is where a reader starts. */
  restart(controller: AbortController) {
    if (current?.controller === controller) current = { ...current, replay: "" };
  },

  append(text: string) {
    if (!current) return;
    if (current.replay === null) {
      current = { ...current, text: current.text + text, lastWordAt: Date.now() };
    } else {
      const replay = current.replay + text;
      current = replay.length < current.text.length
        ? { ...current, replay, lastWordAt: Date.now() }
        : { ...current, text: replay, replay: null, lastWordAt: Date.now() };
    }
    publish();
  },

  /** A reader ended with the turn unfinished. Says how many have, in a row, without
   *  a new word to show for it. */
  closedEarly() {
    if (!current) return 0;
    const closes = current.text.length > current.textAtLastClose ? 1 : current.closes + 1;
    current = { ...current, closes, textAtLastClose: current.text.length };
    return closes;
  },

  /** This reader's turn is over, whether it landed, failed or was stopped. Says
   *  whether that ended anything: a reader that was replaced, or that lost its
   *  connection, ends nothing. */
  end(controller: AbortController) {
    if (current?.controller !== controller || !current.busy) return false;
    current = null;
    publish();
    return true;
  },

  /** This reader's connection is gone and could not be replaced. The turn is not
   *  over as far as anyone knows, so what has arrived stays on screen. */
  lose(controller: AbortController, why: unknown) {
    if (current?.controller !== controller || !current.busy) return;
    current = { ...current, busy: false, lost: why, closes: 0, textAtLastClose: 0 };
    publish();
  },

  /** Enough is known without this reader, whose turn and words are dropped. */
  drop(controller: AbortController | null) {
    if (!controller || current?.controller !== controller) return;
    current = null;
    publish();
    controller.abort();
  },

  /** Whichever reader holds this conversation's turn, if any. */
  readerOf(conversationId: string) {
    return current?.conversationId === conversationId ? current.controller : null;
  },

  /** How long the turn has gone without a word. */
  quietFor() {
    return current ? Date.now() - current.lastWordAt : 0;
  },

  /** Stop the turn from anywhere, including a page that was not there when it
   *  started.
   *
   *  Hanging up is no longer enough. The reply is generated by the server now,
   *  so that closing a tab does not end it — which also means that dropping the
   *  connection cannot be read as "stop", because it is exactly what a phone
   *  going to sleep does. Stopping has to be said. */
  stop() {
    const id = current?.conversationId;
    current?.controller.abort();
    if (id) {
      void data.turns.stop(id).catch(() => {});
    }
  },

  isRunning(conversationId: string) {
    return current?.conversationId === conversationId && current.busy;
  },
};
