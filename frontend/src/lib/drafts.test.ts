import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  clearDraft, giveBack, loadDraft, openBox, pruneDrafts, saveDraft, takeFromBox, withdraw, type MessageMode,
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
    write(text: string, mode: MessageMode) {
      box.shown = text;
      box.mode = mode;
    },
    take() {
      const held = box.shown ? { text: box.shown, mode: box.mode } : null;
      box.shown = "";
      return held;
    },
  };
  return box;
}

describe("a message given back", () => {
  beforeEach(() => useStorage(new MemoryStorage()));

  test("waits for the next box when none is open, as what it was meant as", () => {
    giveBack("v1", "Refused.", "narrate");
    const box = aBox();
    openBox("v1", box)();
    expect(box.shown).toBe("Refused.");
    expect(box.mode).toBe("narrate");
    expect(loadDraft("v1"), "and is an ordinary draft from then on").toBe("Refused.");
  });

  test("goes to one box only", () => {
    giveBack("v1", "Refused.", "say");
    openBox("v1", aBox())();
    const next = aBox(loadDraft("v1"));
    openBox("v1", next)();
    expect(next.shown).toBe("Refused.");
  });

  test("keeps a draft that was there, under it", () => {
    saveDraft("v1", "Started since.");
    giveBack("v1", "Refused.", "say");
    const box = aBox(loadDraft("v1"));
    openBox("v1", box)();
    expect(box.shown).toBe("Refused.\nStarted since.");
  });

  test("is not written over by what another tab saves as its draft", () => {
    giveBack("v1", "Refused.", "say");
    saveDraft("v1", "From the other tab.");
    const box = aBox(loadDraft("v1"));
    openBox("v1", box)();
    expect(box.shown).toBe("Refused.\nFrom the other tab.");
  });

  test("two of them, with no box open, are both kept, in the order they went", () => {
    giveBack("v1", "First.", "say");
    giveBack("v1", "Second.", "ooc");
    const box = aBox();
    openBox("v1", box)();
    expect(box.shown).toBe("First.\nSecond.");
    expect(box.mode).toBe("ooc");
  });

  test("goes to the box that is open, with what has been typed there", () => {
    const box = aBox("Typing.");
    const close = openBox("v1", box);
    giveBack("v1", "Refused.", "ooc");
    expect(box.shown).toBe("Refused.\nTyping.");
    expect(box.mode).toBe("ooc");
    expect(loadDraft("v1"), "and to the draft, in case the page goes").toBe("Refused.\nTyping.");
    close();
  });

  test("not to a box that has closed", () => {
    const box = aBox();
    openBox("v1", box)();
    giveBack("v1", "Refused.", "say");
    expect(box.shown).toBe("");
    const next = aBox();
    openBox("v1", next)();
    expect(next.shown).toBe("Refused.");
  });

  test("a box that has closed does not close the one that replaced it", () => {
    const old = openBox("v1", aBox());
    const current = aBox();
    const close = openBox("v1", current);
    old();
    giveBack("v1", "Refused.", "say");
    expect(current.shown).toBe("Refused.");
    close();
  });

  test("something that is not one, in storage, is not taken for one", () => {
    localStorage.setItem("evermind:returned:v1", "not what this writes");
    const box = aBox();
    openBox("v1", box)();
    expect(box.shown).toBe("");
  });

  test("with storage blocked, keeps the page going", () => {
    blockStorage();
    expect(() => giveBack("v1", "Refused.", "say")).not.toThrow();
    const box = aBox();
    expect(() => openBox("v1", box)()).not.toThrow();
    expect(() => withdraw("v1", "Refused.")).not.toThrow();
  });

  test("is dropped with its conversation, and counts as a draft until then", () => {
    giveBack("kept", "One.", "say");
    giveBack("gone", "Two.", "say");
    expect(pruneDrafts(["kept"])).toEqual(new Set(["kept"]));
    const box = aBox();
    openBox("gone", box)();
    expect(box.shown).toBe("");
  });
});

describe("a message given back that had arrived after all", () => {
  beforeEach(() => useStorage(new MemoryStorage()));

  test("goes from the box, and the box goes back to speaking", () => {
    const box = aBox();
    const close = openBox("v1", box);
    giveBack("v1", "Arrived.", "narrate");
    withdraw("v1", "Arrived.");
    expect(box.shown).toBe("");
    expect(box.mode).toBe("say");
    expect(loadDraft("v1")).toBe("");
    close();
  });

  test("what has been typed under it stays", () => {
    const box = aBox("Typing.");
    const close = openBox("v1", box);
    giveBack("v1", "Arrived.", "say");
    withdraw("v1", "Arrived.");
    expect(box.shown).toBe("Typing.");
    expect(loadDraft("v1")).toBe("Typing.");
    close();
  });

  test("once changed it is another message, and stays", () => {
    const box = aBox();
    const close = openBox("v1", box);
    giveBack("v1", "Arrived.", "say");
    box.shown = "Arrived, and more.";
    withdraw("v1", "Arrived.");
    expect(box.shown).toBe("Arrived, and more.");
    close();
  });

  test("goes from where it waits with no box open", () => {
    giveBack("v1", "Arrived.", "say");
    giveBack("v1", "Refused.", "say");
    withdraw("v1", "Arrived.");
    const box = aBox();
    openBox("v1", box)();
    expect(box.shown).toBe("Refused.");
  });

  test("goes from the draft it had become", () => {
    giveBack("v1", "Arrived.", "say");
    openBox("v1", aBox())();
    withdraw("v1", "Arrived.");
    expect(loadDraft("v1")).toBe("");
  });
});

describe("taking what a box holds", () => {
  beforeEach(() => useStorage(new MemoryStorage()));

  test("empties it", () => {
    const box = aBox("Hello.");
    box.mode = "ooc";
    const close = openBox("v1", box);
    expect(takeFromBox("v1")).toEqual({ text: "Hello.", mode: "ooc" });
    expect(box.shown).toBe("");
    close();
  });

  test("comes to nothing with no box open", () => {
    expect(takeFromBox("v1")).toBeNull();
  });
});
