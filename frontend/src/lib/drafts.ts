/** Unsent message drafts, kept per conversation in the browser.
    Local on purpose: instant, no request per keystroke, and a half-written
    message is personal and ephemeral by nature. */

import { newId } from "@/lib/utils";

const PREFIX = "evermind:draft:";
const SENDING = "evermind:sending:";

/** How a message is meant: spoken, narrating the scene, or out of character. */
export type MessageMode = "say" | "narrate" | "ooc";
const MODES: readonly string[] = ["say", "narrate", "ooc"];

/** A message from before it is sent until the conversation is known to have it. It
 *  is what the message comes back from, whatever happens meanwhile: a lost connection,
 *  a reload, a tab that a phone has discarded. Its id is how the server knows it if it
 *  is sent again, and how a page knows it in the conversation. */
export interface Sending {
  clientId: string;
  text: string;
  mode: MessageMode;
  /** It has gone back to a box, and so to the draft. Until then it is for the next one. */
  inBox: boolean;
}

// The same, for as long as this page lives: all there is where storage may not be
// used, and what this tab goes by when another writes over what is in storage.
const sending = new Map<string, Sending>();
// Those that this page has a request open for, which are not to be offered back yet.
const onItsWay = new Set<string>();

export function loadDraft(conversationId: string): string {
  try {
    return localStorage.getItem(PREFIX + conversationId) ?? "";
  } catch {
    return ""; // storage this site may not use keeps no draft
  }
}

export function saveDraft(conversationId: string, text: string): void {
  try {
    if (text.trim()) localStorage.setItem(PREFIX + conversationId, text);
    else localStorage.removeItem(PREFIX + conversationId);
  } catch {
    /* quota exceeded or storage disabled: drafts are a convenience, never fail */
  }
}

export function clearDraft(conversationId: string): void {
  try {
    localStorage.removeItem(PREFIX + conversationId);
  } catch {
    /* storage this site may not use has nothing to clear */
  }
}

function stored(conversationId: string): Sending | null {
  try {
    const kept = JSON.parse(localStorage.getItem(SENDING + conversationId) ?? "null");
    if (typeof kept?.clientId !== "string" || typeof kept?.text !== "string") return null;
    return {
      clientId: kept.clientId,
      text: kept.text,
      mode: MODES.includes(kept.mode) ? kept.mode : "say",
      inBox: kept.inBox === true,
    };
  } catch {
    return null; // nothing readable was kept, or storage this site may not use
  }
}

function loadSending(conversationId: string): Sending | null {
  return sending.get(conversationId) ?? stored(conversationId);
}

function saveSending(conversationId: string, message: Sending): void {
  sending.set(conversationId, message);
  try {
    localStorage.setItem(SENDING + conversationId, JSON.stringify(message));
  } catch {
    /* quota exceeded or storage disabled: it lasts as long as the page, then */
  }
}

/** The conversation has this message, so nothing more is to be done with it. */
export function messageArrived(conversationId: string, clientId: string): void {
  onItsWay.delete(clientId);
  if (sending.get(conversationId)?.clientId === clientId) sending.delete(conversationId);
  try {
    if (stored(conversationId)?.clientId === clientId) localStorage.removeItem(SENDING + conversationId);
  } catch {
    /* storage this site may not use has nothing to clear */
  }
}

/** The second text on a line after the first, if there is anything to it. */
const followedBy = (first: string, second: string) => (second.trim() ? `${first}\n${second}` : first);

/** What is left of a text without a message at its start, if the message is there. */
function without(text: string, message: string): string | null {
  if (text === message) return "";
  return text.startsWith(`${message}\n`) ? text.slice(message.length + 1) : null;
}

/** The box open for a conversation, if one is. */
interface Box {
  read(): string;
  /** With a mode to change to, if it is to change. */
  write(text: string, mode?: MessageMode): void;
  /** Empties it, as sending what it holds does, and says what that was, if anything. */
  take(): Pick<Sending, "text" | "mode"> | null;
}
const boxes = new Map<string, Box>();

/** Whatever has been typed there stays, under it, and decides what it is meant as. */
function intoBox(conversationId: string, message: Sending, box: Box): void {
  const typed = box.read();
  const kept = followedBy(message.text, typed);
  saveDraft(conversationId, kept);
  saveSending(conversationId, { ...message, inBox: true });
  box.write(kept, typed.trim() ? undefined : message.mode);
}

/** Says that this box is open, and hands it a message that did not get anywhere and
 *  has been waiting for one. By now the conversation has been read, so it is known not
 *  to have it. If the draft it has opened on is that message, this says what it is
 *  meant as, which a draft does not. Returns the function that says the box has closed. */
export function openBox(conversationId: string, box: Box): () => void {
  boxes.set(conversationId, box);
  const message = loadSending(conversationId);
  if (message && !onItsWay.has(message.clientId)) {
    if (!message.inBox) intoBox(conversationId, message, box);
    else if (box.read() === message.text) box.write(message.text, message.mode);
  }
  return () => {
    if (boxes.get(conversationId) === box) boxes.delete(conversationId);
  };
}

/** Writes a message down before it goes, and says the id to send it under: the one it
 *  had if this is the same message sent again, which it is while its words are the same. */
export function beginSending(conversationId: string, text: string, mode: MessageMode): string {
  const before = loadSending(conversationId);
  const clientId = before?.text === text ? before.clientId : newId();
  saveSending(conversationId, { clientId, text, mode, inBox: false });
  onItsWay.add(clientId);
  return clientId;
}

/** A message that did not begin its turn goes back where it came from, as what it was
 *  meant as, unless it is known by now to have arrived. The person may have left, and
 *  come back or not: with no box open it waits for the next. */
export function giveBack(conversationId: string, clientId: string): void {
  onItsWay.delete(clientId);
  const message = loadSending(conversationId);
  if (message?.clientId !== clientId || message.inBox) return;
  const box = boxes.get(conversationId);
  if (box) intoBox(conversationId, message, box);
}

/** What has been read of a conversation, which says whether a message sent to it has
 *  arrived. One that went back to a box goes from there too, as sending it again would
 *  come to nothing. What was typed around it is not touched, nor is the message once it
 *  has been changed, which makes it another message. Says whether it had arrived. */
export function settleSending(
  conversationId: string,
  messages: { meta?: Record<string, unknown> }[],
): boolean {
  const message = loadSending(conversationId);
  if (!message || !messages.some((m) => m.meta?.client_id === message.clientId)) return false;
  messageArrived(conversationId, message.clientId);
  if (!message.inBox) return true;
  const box = boxes.get(conversationId);
  const rest = without(box ? box.read() : loadDraft(conversationId), message.text);
  if (rest === null) return true;
  saveDraft(conversationId, rest);
  box?.write(rest, rest.trim() ? undefined : "say");
  return true;
}

/** The message that came back rather than arriving, if there is one here. */
export function givenBack(conversationId: string): Sending | null {
  const message = loadSending(conversationId);
  return message && !onItsWay.has(message.clientId) ? message : null;
}

/** What the box holds, for sending it: gone from there, as if its button had been pressed. */
export function takeFromBox(conversationId: string): Pick<Sending, "text" | "mode"> | null {
  return boxes.get(conversationId)?.take() ?? null;
}

/** Ids that currently hold a draft, restricted to conversations that still
    exist; drafts of deleted conversations are removed along the way. */
export function pruneDrafts(existingIds: string[]): Set<string> {
  const alive = new Set(existingIds);
  const withDraft = new Set<string>();
  try {
    for (const key of Object.keys(localStorage)) {
      const prefix = [PREFIX, SENDING].find((p) => key.startsWith(p));
      if (!prefix) continue;
      const id = key.slice(prefix.length);
      if (!alive.has(id)) {
        localStorage.removeItem(key);
        continue;
      }
      // One in a box is as much of a draft as the draft says, and one on its way is not.
      const message = prefix === SENDING ? stored(id) : null;
      if (prefix === PREFIX || (message && !message.inBox && !onItsWay.has(message.clientId))) withDraft.add(id);
    }
  } catch {
    /* storage this site may not use keeps no draft */
  }
  return withDraft;
}
