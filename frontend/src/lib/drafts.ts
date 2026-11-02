/** Unsent message drafts, kept per conversation in the browser.
    Local on purpose: instant, no request per keystroke, and a half-written
    message is personal and ephemeral by nature. */

const PREFIX = "evermind:draft:";
// A message given back with no box open to take it. Apart from the draft, which any
// tab with this conversation open writes over as soon as something is typed there.
const RETURNED = "evermind:returned:";

/** How a message is meant: spoken, narrating the scene, or out of character. */
export type MessageMode = "say" | "narrate" | "ooc";

interface Held {
  text: string;
  mode: MessageMode;
}

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

function loadReturned(conversationId: string): Held | null {
  try {
    const kept = JSON.parse(localStorage.getItem(RETURNED + conversationId) ?? "null");
    return typeof kept?.text === "string" ? { text: kept.text, mode: kept.mode ?? "say" } : null;
  } catch {
    return null; // nothing readable was kept, or storage this site may not use
  }
}

function saveReturned(conversationId: string, held: Held | null): void {
  try {
    if (held) localStorage.setItem(RETURNED + conversationId, JSON.stringify(held));
    else localStorage.removeItem(RETURNED + conversationId);
  } catch {
    /* quota exceeded or storage disabled: as for drafts */
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
  write(text: string, mode: MessageMode): void;
  /** Empties it, as sending what it holds does, and says what that was, if anything. */
  take(): Held | null;
}
const boxes = new Map<string, Box>();

/** Says that this box is open, and hands it whatever was given back while none was.
 *  Returns the function that says it has closed. */
export function openBox(conversationId: string, box: Box): () => void {
  boxes.set(conversationId, box);
  const back = loadReturned(conversationId);
  if (back) {
    const kept = followedBy(back.text, box.read());
    saveDraft(conversationId, kept);
    saveReturned(conversationId, null);
    box.write(kept, back.mode);
  }
  return () => {
    if (boxes.get(conversationId) === box) boxes.delete(conversationId);
  };
}

/** A message that did not go goes back where it came from, as what it was meant as.
 *  The person may have left by then, and come back or not: with no box open it waits
 *  for the next one. Whatever has been typed there since stays too, under it. */
export function giveBack(conversationId: string, message: string, mode: MessageMode): void {
  const box = boxes.get(conversationId);
  if (!box) {
    const back = loadReturned(conversationId);
    saveReturned(conversationId, { text: back ? followedBy(back.text, message) : message, mode });
    return;
  }
  const kept = followedBy(message, box.read());
  saveDraft(conversationId, kept);
  box.write(kept, mode);
}

/** A message given back that turns out to have arrived, its answer being what was
 *  lost. Sending it again would say it twice. What was typed around it is not touched,
 *  nor is the message once it has been changed, which makes it another message. */
export function withdraw(conversationId: string, message: string): void {
  const back = loadReturned(conversationId);
  const unclaimed = back && without(back.text, message);
  if (back && unclaimed !== null) {
    saveReturned(conversationId, unclaimed ? { ...back, text: unclaimed } : null);
  }
  const box = boxes.get(conversationId);
  const rest = without(box ? box.read() : loadDraft(conversationId), message);
  if (rest === null) return;
  saveDraft(conversationId, rest);
  box?.write(rest, "say");
}

/** What the box holds, for sending it: gone from there, as if its button had been pressed. */
export function takeFromBox(conversationId: string): Held | null {
  return boxes.get(conversationId)?.take() ?? null;
}

/** Ids that currently hold a draft, restricted to conversations that still
    exist; drafts of deleted conversations are removed along the way. */
export function pruneDrafts(existingIds: string[]): Set<string> {
  const alive = new Set(existingIds);
  const withDraft = new Set<string>();
  try {
    for (const key of Object.keys(localStorage)) {
      const prefix = [PREFIX, RETURNED].find((p) => key.startsWith(p));
      if (!prefix) continue;
      const id = key.slice(prefix.length);
      if (alive.has(id)) withDraft.add(id);
      else localStorage.removeItem(key);
    }
  } catch {
    /* storage this site may not use keeps no draft */
  }
  return withDraft;
}
