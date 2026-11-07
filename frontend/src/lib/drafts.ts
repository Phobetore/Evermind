/** Unsent message drafts, kept per conversation in the browser.
    Local on purpose: instant, no request per keystroke, and a half-written
    message is personal and ephemeral by nature. */

import { newId } from "@/lib/utils";

const PREFIX = "evermind:draft:";
const SENDING = "evermind:sending:";

/** How a message is meant: spoken, narrating the scene, or out of character. */
export type MessageMode = "say" | "narrate" | "ooc";
const MODES: readonly string[] = ["say", "narrate", "ooc"];

/** A message until the server is known to have it, in the box meanwhile; its id names it there. */
interface Sending {
  clientId: string;
  text: string;
  mode: MessageMode;
}

// The same, for as long as this page lives: all there is where storage may not be used.
const sending = new Map<string, Sending>();

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
  saveDraft(conversationId, "");
}

function stored(conversationId: string): Sending | null {
  try {
    const kept = JSON.parse(localStorage.getItem(SENDING + conversationId) ?? "null");
    if (typeof kept?.clientId !== "string" || typeof kept?.text !== "string") return null;
    return { clientId: kept.clientId, text: kept.text, mode: MODES.includes(kept.mode) ? kept.mode : "say" };
  } catch {
    return null; // nothing readable was kept, or storage this site may not use
  }
}

const loadSending = (conversationId: string) => sending.get(conversationId) ?? stored(conversationId);

/** Writes a message down before it goes: the same words keep the id they were sent under. */
export function beginSending(conversationId: string, text: string, mode: MessageMode): string {
  const before = loadSending(conversationId);
  const message = { clientId: before?.text === text ? before.clientId : newId(), text, mode };
  sending.set(conversationId, message);
  try {
    localStorage.setItem(SENDING + conversationId, JSON.stringify(message));
  } catch {
    /* quota exceeded or storage disabled: it lasts as long as the page, then */
  }
  return message.clientId;
}

/** The server has this message. */
export function forgetSending(conversationId: string, clientId: string): void {
  if (sending.get(conversationId)?.clientId === clientId) sending.delete(conversationId);
  try {
    if (stored(conversationId)?.clientId === clientId) localStorage.removeItem(SENDING + conversationId);
  } catch {
    /* storage this site may not use has nothing to clear */
  }
}

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
}
const boxes = new Map<string, Box>();

/** A box opening on a message on its way is told what it was meant as. Returns its closing. */
export function openBox(conversationId: string, box: Box): () => void {
  boxes.set(conversationId, box);
  const message = loadSending(conversationId);
  if (message && box.read() === message.text) box.write(message.text, message.mode);
  return () => {
    if (boxes.get(conversationId) === box) boxes.delete(conversationId);
  };
}

/** A message whose answer was lost and that arrived after all leaves the head of the box, or the
 *  draft, and what was typed under it stays. Says whether it had arrived. */
export function settleSending(
  conversationId: string,
  messages: { meta?: Record<string, unknown> }[],
): boolean {
  const message = loadSending(conversationId);
  if (!message || !messages.some((m) => m.meta?.client_id === message.clientId)) return false;
  forgetSending(conversationId, message.clientId);
  const box = boxes.get(conversationId);
  const rest = box ? without(box.read(), message.text) : null;
  if (box && rest !== null) {
    saveDraft(conversationId, rest);
    box.write(rest, rest.trim() ? undefined : "say");
  } else {
    const inDraft = without(loadDraft(conversationId), message.text);
    if (inDraft !== null) saveDraft(conversationId, inDraft);
  }
  return true;
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
      if (!alive.has(id)) localStorage.removeItem(key);
      else if (prefix === PREFIX) withDraft.add(id);
    }
  } catch {
    /* storage this site may not use keeps no draft */
  }
  return withDraft;
}
