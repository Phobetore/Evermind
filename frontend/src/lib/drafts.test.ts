import { afterEach, describe, expect, test } from "vitest";
import { clearDraft, loadDraft, pruneDrafts, saveDraft } from "./drafts";

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
