/** Unsent message drafts, kept per conversation in the browser.
    Local on purpose: instant, no request per keystroke, and a half-written
    message is personal and ephemeral by nature. */

const PREFIX = "evermind:draft:";

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

/** The box open for a conversation, if one is. */
interface Box {
  read(): string;
  write(text: string): void;
}
const boxes = new Map<string, Box>();

/** Says that this box is open. Returns the function that says it has closed. */
export function openBox(conversationId: string, box: Box): () => void {
  boxes.set(conversationId, box);
  return () => {
    if (boxes.get(conversationId) === box) boxes.delete(conversationId);
  };
}

/** A message that was refused goes back where it came from. The person may have left
 *  by then, and come back or not, so it goes to the draft in any case, and to whichever
 *  box is open. Whatever has been typed there since stays too, under it. */
export function giveBack(conversationId: string, message: string): void {
  const box = boxes.get(conversationId);
  const typed = box ? box.read() : loadDraft(conversationId);
  const kept = typed.trim() ? `${message}\n${typed}` : message;
  saveDraft(conversationId, kept);
  box?.write(kept);
}

/** Ids that currently hold a draft, restricted to conversations that still
    exist; drafts of deleted conversations are removed along the way. */
export function pruneDrafts(existingIds: string[]): Set<string> {
  const alive = new Set(existingIds);
  const withDraft = new Set<string>();
  try {
    for (const key of Object.keys(localStorage)) {
      if (!key.startsWith(PREFIX)) continue;
      const id = key.slice(PREFIX.length);
      if (alive.has(id)) withDraft.add(id);
      else localStorage.removeItem(key);
    }
  } catch {
    /* storage this site may not use keeps no draft */
  }
  return withDraft;
}
