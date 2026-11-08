import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  arrived, beginSending, clearDraft, forgetSending, loadDraft, openBox, pruneDrafts, saveDraft, settleSending,
  type MessageMode,
} from "./drafts";

/** Kept items are own properties, the methods are not, so `Object.keys` lists
 *  what is stored, as it does for the browser's own storage. */
class MemoryStorage {
  [key: string]: unknown;
  getItem(key: string): string | null {
    return Object.hasOwn(this, key) ? String(this[key]) : null;
  }
  setItem(key: string, value: string): void {
    this[key] = String(value);
  }
  removeItem(key: string): void {
    delete this[key];
  }
}

function useStorage(storage: unknown) {
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
}

/** What a browser that keeps no site data does: reaching for the storage at all throws. */
function blockStorage() {
  Object.defineProperty(globalThis, "localStorage", {
    get() {
      throw new DOMException("The operation is insecure.", "SecurityError");
    },
    configurable: true,
  });
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "localStorage");
});

describe("drafts", () => {
  test("a draft is kept per conversation until it is cleared", () => {
    useStorage(new MemoryStorage());
    saveDraft("a", "I was about to say");
    expect(loadDraft("a")).toBe("I was about to say");
    expect(loadDraft("b")).toBe("");
    clearDraft("a");
    expect(loadDraft("a")).toBe("");
  });

  test("saving nothing but spaces forgets the draft", () => {
    useStorage(new MemoryStorage());
    saveDraft("a", "words");
    saveDraft("a", "   ");
    expect(loadDraft("a")).toBe("");
  });

  test("blocked storage loses the draft and nothing else", () => {
    blockStorage();
    expect(() => saveDraft("a", "words")).not.toThrow();
    expect(loadDraft("a")).toBe("");
    expect(() => clearDraft("a")).not.toThrow();
    expect(pruneDrafts(["a"])).toEqual(new Set());
  });

  test("storage that refuses to write keeps the page going", () => {
    const full = new MemoryStorage();
    full.setItem = () => {
      throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
    };
    useStorage(full);
    expect(() => saveDraft("a", "words")).not.toThrow();
    expect(loadDraft("a")).toBe("");
  });

  test("drafts of conversations that are gone are dropped, the others reported", () => {
    const storage = new MemoryStorage();
    useStorage(storage);
    saveDraft("kept", "one");
    saveDraft("gone", "two");
    storage.setItem("evermind:locale", "fr");
    expect(pruneDrafts(["kept", "other"])).toEqual(new Set(["kept"]));
    expect(loadDraft("gone")).toBe("");
    expect(storage.getItem("evermind:locale")).toBe("fr");
  });
});

/** A box as the page has one, and what it shows. */
function aBox(typed = "") {
  const box = {
    shown: typed,
    mode: "say" as MessageMode,
    read: () => box.shown,
    write(text: string, mode?: MessageMode) {
      box.shown = text;
      if (mode) box.mode = mode;
    },
  };
  return box;
}

/** A conversation of its own for each test: what is being sent lasts as long as the
 *  page does, and to a module that is as long as the run. */
let conversations = 0;
const aConversation = () => `v${++conversations}`;

/** The same page after a reload, or a tab discarded by a phone, or another tab: what is
 *  in storage and nothing else. */
async function anotherPage() {
  vi.resetModules();
  return import("./drafts");
}

const inConversation = (clientId: string) => [{ meta: {} }, { meta: { client_id: clientId } }];

/** What a page does with a message it sends: it stays in the box, and so in the draft. */
function sent(id: string, text: string, mode: MessageMode = "say") {
  saveDraft(id, text);
  return beginSending(id, text, mode);
}

describe("a message being sent", () => {
  beforeEach(() => useStorage(new MemoryStorage()));

  test("goes under an id of its own", () => {
    const [a, b] = [aConversation(), aConversation()];
    expect(sent(a, "Hello.")).not.toBe(sent(b, "Hello."));
  });

  test("keeps that id while its words are the same, and only then", () => {
    const id = aConversation();
    const first = sent(id, "Hello.");
    expect(sent(id, "Hello.", "narrate"), "sent again").toBe(first);
    expect(sent(id, "Hello, you."), "changed").not.toBe(first);
  });

  test("gets a new one once the server has it, since saying it again is saying it again", () => {
    const id = aConversation();
    const first = sent(id, "Hello.");
    forgetSending(id, first);
    expect(sent(id, "Hello.")).not.toBe(first);
  });

  test("keeps its id through a reload, and the box that opens on it knows what it was meant as", async () => {
    const id = aConversation();
    const clientId = sent(id, "Hello.", "narrate");
    const next = await anotherPage();
    const box = aBox(next.loadDraft(id));
    next.openBox(id, box)();
    expect(box.shown).toBe("Hello.");
    expect(box.mode).toBe("narrate");
    expect(next.beginSending(id, "Hello.", "narrate")).toBe(clientId);
  });

  test("leaves a box that opens on something else as it is", () => {
    const id = aConversation();
    sent(id, "Hello.", "ooc");
    const box = aBox("Something else.");
    openBox(id, box)();
    expect(box.shown).toBe("Something else.");
    expect(box.mode).toBe("say");
  });

  test("a mode nobody knows, in storage, is speaking", () => {
    const id = aConversation();
    localStorage.setItem(`evermind:sending:${id}`, JSON.stringify({ clientId: "x", text: "Hi.", mode: "shout" }));
    const box = aBox("Hi.");
    openBox(id, box)();
    expect(box.mode).toBe("say");
  });

  test("with storage blocked, keeps the page going, and lasts as long as it does", () => {
    const id = aConversation();
    blockStorage();
    const clientId = beginSending(id, "Refused.", "ooc");
    expect(beginSending(id, "Refused.", "ooc")).toBe(clientId);
    const box = aBox("Refused.");
    expect(() => openBox(id, box)()).not.toThrow();
    expect(box.mode).toBe("ooc");
    expect(() => settleSending(id, [])).not.toThrow();
  });

  test("is dropped with its conversation, and is no draft of its own", () => {
    const [kept, gone, sending] = [aConversation(), aConversation(), aConversation()];
    sent(kept, "One.");
    sent(gone, "Two.");
    beginSending(sending, "Three.", "say");
    expect(pruneDrafts([kept, sending])).toEqual(new Set([kept]));
    expect(localStorage.getItem(`evermind:sending:${gone}`)).toBeNull();
  });
});

describe("a message whose answer was lost, and which had arrived after all", () => {
  beforeEach(() => useStorage(new MemoryStorage()));

  test("goes from the box, and the box goes back to speaking", () => {
    const id = aConversation();
    const clientId = sent(id, "Arrived.", "narrate");
    const box = aBox("Arrived.");
    const close = openBox(id, box);
    expect(settleSending(id, inConversation(clientId))).toBe(true);
    expect(box.shown).toBe("");
    expect(box.mode).toBe("say");
    expect(loadDraft(id)).toBe("");
    close();
  });

  test("what has been typed under it stays, and what it is meant as", () => {
    const id = aConversation();
    const clientId = sent(id, "Arrived.", "ooc");
    const box = aBox("Arrived.");
    const close = openBox(id, box);
    box.shown = "Arrived.\nAnd then this.";
    settleSending(id, inConversation(clientId));
    expect(box.shown).toBe("And then this.");
    expect(box.mode).toBe("ooc");
    expect(loadDraft(id)).toBe("And then this.");
    close();
  });

  test("once changed it is another message, and stays", () => {
    const id = aConversation();
    const clientId = sent(id, "Arrived.");
    const box = aBox("Arrived, and changed.");
    const close = openBox(id, box);
    expect(settleSending(id, inConversation(clientId))).toBe(true);
    expect(box.shown).toBe("Arrived, and changed.");
    close();
  });

  test("the same words are not what says so, only its id", () => {
    const id = aConversation();
    sent(id, "Arrived.");
    const box = aBox("Arrived.");
    const close = openBox(id, box);
    expect(settleSending(id, inConversation("another"))).toBe(false);
    expect(box.shown).toBe("Arrived.");
    close();
  });

  test("goes from the draft when no box is open, and is not offered again", async () => {
    const id = aConversation();
    const clientId = sent(id, "Arrived.");
    saveDraft(id, "Arrived.\nAnd then this.");
    const next = await anotherPage();
    expect(next.settleSending(id, inConversation(clientId))).toBe(true);
    expect(next.loadDraft(id)).toBe("And then this.");
    expect(next.settleSending(id, inConversation(clientId)), "once is enough").toBe(false);
  });
});

describe("a message the server has taken", () => {
  beforeEach(() => useStorage(new MemoryStorage()));

  test("leaves the box open for its conversation now, not the one it was sent from", () => {
    const id = aConversation();
    const clientId = sent(id, "Taken.", "narrate");
    openBox(id, aBox("Taken."))(); // the page it was sent from, left
    const now = aBox("Taken.");
    const close = openBox(id, now);
    expect(arrived(id, clientId)).toBe(true);
    expect(now.shown).toBe("");
    expect(now.mode).toBe("say");
    expect(loadDraft(id)).toBe("");
    close();
  });

  test("leaves the draft when no box is open", () => {
    const id = aConversation();
    const clientId = sent(id, "Taken.");
    expect(arrived(id, clientId)).toBe(true);
    expect(loadDraft(id)).toBe("");
  });

  test("does so once: the same words typed again after it stay", () => {
    const id = aConversation();
    const clientId = sent(id, "Taken.");
    arrived(id, clientId);
    const box = aBox("Taken.");
    const close = openBox(id, box);
    expect(arrived(id, clientId), "answered twice").toBe(false);
    expect(box.shown).toBe("Taken.");
    close();
  });
});
