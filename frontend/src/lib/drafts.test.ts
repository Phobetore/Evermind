import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  beginSending, clearDraft, giveBack, givenBack, loadDraft, messageArrived, openBox, pruneDrafts, saveDraft,
  settleSending, takeFromBox, type MessageMode,
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
    take() {
      const held = box.shown ? { text: box.shown, mode: box.mode } : null;
      box.shown = "";
      return held;
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

describe("a message being sent", () => {
  beforeEach(() => useStorage(new MemoryStorage()));

  test("goes under an id of its own", () => {
    const [a, b] = [aConversation(), aConversation()];
    expect(beginSending(a, "Hello.", "say")).not.toBe(beginSending(b, "Hello.", "say"));
  });

  test("keeps that id while its words are the same, and only then", () => {
    const id = aConversation();
    const first = beginSending(id, "Hello.", "say");
    giveBack(id, first);
    expect(beginSending(id, "Hello.", "narrate"), "sent again").toBe(first);
    giveBack(id, first);
    expect(beginSending(id, "Hello, you.", "say"), "changed").not.toBe(first);
  });

  test("gets a new one once it has arrived, since saying it again is saying it again", () => {
    const id = aConversation();
    const first = beginSending(id, "Hello.", "say");
    messageArrived(id, first);
    expect(beginSending(id, "Hello.", "say")).not.toBe(first);
  });

  test("is not offered to a box while it is on its way", () => {
    const id = aConversation();
    const clientId = beginSending(id, "Hello.", "say");
    const box = aBox();
    const close = openBox(id, box);
    expect(box.shown).toBe("");
    expect(givenBack(id)).toBeNull();
    giveBack(id, clientId);
    expect(box.shown).toBe("Hello.");
    close();
  });

  test("survives the page, and the next box takes it, as what it was meant as", async () => {
    const id = aConversation();
    beginSending(id, "Hello.", "narrate");
    const { openBox: openNext, givenBack: nextGivenBack } = await anotherPage();
    expect(nextGivenBack(id)?.text, "not on its way from this page").toBe("Hello.");
    const box = aBox();
    openNext(id, box)();
    expect(box.shown).toBe("Hello.");
    expect(box.mode).toBe("narrate");
    expect(loadDraft(id), "and is an ordinary draft from then on").toBe("Hello.");
  });

  test("is not offered by the next page if the conversation has it", async () => {
    const id = aConversation();
    const clientId = beginSending(id, "Hello.", "say");
    const next = await anotherPage();
    expect(next.settleSending(id, inConversation(clientId))).toBe(true);
    const box = aBox();
    next.openBox(id, box)();
    expect(box.shown).toBe("");
    expect(next.givenBack(id)).toBeNull();
  });
});

describe("a message given back", () => {
  beforeEach(() => useStorage(new MemoryStorage()));

  const sentAndBack = (id: string, text: string, mode: MessageMode = "say") => {
    const clientId = beginSending(id, text, mode);
    giveBack(id, clientId);
    return clientId;
  };

  test("waits for the next box when none is open, as what it was meant as", () => {
    const id = aConversation();
    sentAndBack(id, "Refused.", "narrate");
    const box = aBox();
    openBox(id, box)();
    expect(box.shown).toBe("Refused.");
    expect(box.mode).toBe("narrate");
    expect(loadDraft(id), "and is an ordinary draft from then on").toBe("Refused.");
  });

  test("is still what it was meant as when a box opens on it as a draft", async () => {
    const id = aConversation();
    const box = aBox();
    openBox(id, box)();
    const { clientId } = { clientId: beginSending(id, "Refused.", "narrate") };
    const open = openBox(id, box);
    giveBack(id, clientId);
    open();

    const next = await anotherPage();
    const reopened = aBox(next.loadDraft(id));
    next.openBox(id, reopened)();
    expect(reopened.shown).toBe("Refused.");
    expect(reopened.mode).toBe("narrate");

    const changed = aBox("Refused, and changed.");
    next.openBox(id, changed)();
    expect(changed.mode, "not once it is something else").toBe("say");
  });

  test("goes to one box only", () => {
    const id = aConversation();
    sentAndBack(id, "Refused.");
    openBox(id, aBox())();
    const next = aBox(loadDraft(id));
    openBox(id, next)();
    expect(next.shown).toBe("Refused.");
  });

  test("keeps a draft that was there, under it, and what that was meant as", () => {
    const id = aConversation();
    saveDraft(id, "Started since.");
    sentAndBack(id, "Refused.", "ooc");
    const box = aBox(loadDraft(id));
    openBox(id, box)();
    expect(box.shown).toBe("Refused.\nStarted since.");
    expect(box.mode, "the message's mode, on what is mostly something else").toBe("say");
  });

  test("is not written over by what another tab saves as its draft", () => {
    const id = aConversation();
    sentAndBack(id, "Refused.");
    saveDraft(id, "From the other tab.");
    const box = aBox(loadDraft(id));
    openBox(id, box)();
    expect(box.shown).toBe("Refused.\nFrom the other tab.");
  });

  test("goes to the box that is open, with what has been typed there", () => {
    const id = aConversation();
    const box = aBox("Typing.");
    const close = openBox(id, box);
    sentAndBack(id, "Refused.", "ooc");
    expect(box.shown).toBe("Refused.\nTyping.");
    expect(box.mode).toBe("say");
    expect(loadDraft(id), "and to the draft, in case the page goes").toBe("Refused.\nTyping.");
    close();
  });

  test("to an empty box, as what it was meant as", () => {
    const id = aConversation();
    const box = aBox();
    const close = openBox(id, box);
    sentAndBack(id, "Refused.", "ooc");
    expect(box.mode).toBe("ooc");
    close();
  });

  test("not to a box that has closed", () => {
    const id = aConversation();
    const box = aBox();
    openBox(id, box)();
    sentAndBack(id, "Refused.");
    expect(box.shown).toBe("");
    const next = aBox();
    openBox(id, next)();
    expect(next.shown).toBe("Refused.");
  });

  test("a box that has closed does not close the one that replaced it", () => {
    const id = aConversation();
    const old = openBox(id, aBox());
    const current = aBox();
    const close = openBox(id, current);
    old();
    sentAndBack(id, "Refused.");
    expect(current.shown).toBe("Refused.");
    close();
  });

  test("not if the conversation has been seen to have it by then", () => {
    const id = aConversation();
    const box = aBox();
    const close = openBox(id, box);
    const clientId = beginSending(id, "Arrived.", "say");
    settleSending(id, inConversation(clientId));
    giveBack(id, clientId);
    expect(box.shown).toBe("");
    close();
  });

  test("not if another has taken its place, which is not its to give back", () => {
    const id = aConversation();
    const box = aBox();
    const close = openBox(id, box);
    const first = beginSending(id, "First.", "say");
    beginSending(id, "Second.", "say");
    giveBack(id, first);
    expect(box.shown).toBe("");
    close();
  });

  test("something that is not one, in storage, is not taken for one", async () => {
    const id = aConversation();
    localStorage.setItem(`evermind:sending:${id}`, "not what this writes");
    const box = aBox();
    openBox(id, box)();
    expect(box.shown).toBe("");
    localStorage.setItem(`evermind:sending:${id}`, JSON.stringify({ text: "No id.", mode: "say" }));
    openBox(id, box)();
    expect(box.shown).toBe("");
  });

  test("a mode nobody knows, in storage, is speaking", () => {
    const id = aConversation();
    localStorage.setItem(`evermind:sending:${id}`, JSON.stringify({ clientId: "x", text: "Hi.", mode: "shout" }));
    const box = aBox();
    openBox(id, box)();
    expect(box.shown).toBe("Hi.");
    expect(box.mode).toBe("say");
  });

  test("with storage blocked, keeps the page going, and lasts as long as it does", () => {
    const id = aConversation();
    blockStorage();
    sentAndBack(id, "Refused.", "ooc");
    const box = aBox();
    expect(() => openBox(id, box)()).not.toThrow();
    expect(box.shown).toBe("Refused.");
    expect(box.mode).toBe("ooc");
    expect(() => settleSending(id, [])).not.toThrow();
    expect(givenBack(id)?.text).toBe("Refused.");
  });

  test("is dropped with its conversation, and counts as a draft until a box has it", () => {
    const [kept, gone, inABox, going] = [aConversation(), aConversation(), aConversation(), aConversation()];
    sentAndBack(kept, "One.");
    sentAndBack(gone, "Two.");
    sentAndBack(inABox, "Three.");
    openBox(inABox, aBox())();
    clearDraft(inABox);
    beginSending(going, "Four.", "say");
    expect(pruneDrafts([kept, inABox, going])).toEqual(new Set([kept]));
    expect(localStorage.getItem(`evermind:sending:${gone}`)).toBeNull();
  });
});

describe("a message given back that had arrived after all", () => {
  beforeEach(() => useStorage(new MemoryStorage()));

  const inABox = (id: string, text: string, mode: MessageMode, box: ReturnType<typeof aBox>) => {
    const close = openBox(id, box);
    const clientId = beginSending(id, text, mode);
    giveBack(id, clientId);
    return { clientId, close };
  };

  test("goes from the box, and the box goes back to speaking", () => {
    const id = aConversation();
    const box = aBox();
    const { clientId, close } = inABox(id, "Arrived.", "narrate", box);
    expect(settleSending(id, inConversation(clientId))).toBe(true);
    expect(box.shown).toBe("");
    expect(box.mode).toBe("say");
    expect(loadDraft(id)).toBe("");
    close();
  });

  test("what has been typed under it stays, and what it is meant as", () => {
    const id = aConversation();
    const box = aBox("Typing.");
    box.mode = "ooc";
    const { clientId, close } = inABox(id, "Arrived.", "say", box);
    settleSending(id, inConversation(clientId));
    expect(box.shown).toBe("Typing.");
    expect(box.mode).toBe("ooc");
    expect(loadDraft(id)).toBe("Typing.");
    close();
  });

  test("once changed it is another message, and stays", () => {
    const id = aConversation();
    const box = aBox();
    const { clientId, close } = inABox(id, "Arrived.", "say", box);
    box.shown = "Arrived, and more.";
    settleSending(id, inConversation(clientId));
    expect(box.shown).toBe("Arrived, and more.");
    close();
  });

  test("the same words are not what says so, only its id", () => {
    const id = aConversation();
    const box = aBox();
    const { close } = inABox(id, "Oui.", "say", box);
    expect(settleSending(id, [{ meta: { client_id: "from another device" } }, { meta: {} }])).toBe(false);
    expect(box.shown).toBe("Oui.");
    close();
  });

  test("goes from the draft it had become, on another page", async () => {
    const id = aConversation();
    const { clientId, close } = inABox(id, "Arrived.", "say", aBox());
    close();
    const next = await anotherPage();
    next.settleSending(id, inConversation(clientId));
    expect(next.loadDraft(id)).toBe("");
  });

  test("goes from a tab whose message another tab saw arrive", async () => {
    const id = aConversation();
    const box = aBox();
    const { clientId, close } = inABox(id, "Arrived.", "say", box);
    const other = await anotherPage();
    other.settleSending(id, inConversation(clientId));
    expect(localStorage.getItem(`evermind:sending:${id}`)).toBeNull();

    expect(settleSending(id, inConversation(clientId)), "this one still knows it").toBe(true);
    expect(box.shown).toBe("");
    close();
  });
});

describe("taking what a box holds", () => {
  beforeEach(() => useStorage(new MemoryStorage()));

  test("empties it", () => {
    const id = aConversation();
    const box = aBox("Hello.");
    box.mode = "ooc";
    const close = openBox(id, box);
    expect(takeFromBox(id)).toEqual({ text: "Hello.", mode: "ooc" });
    expect(box.shown).toBe("");
    close();
  });

  test("comes to nothing with no box open", () => {
    expect(takeFromBox(aConversation())).toBeNull();
  });
});
