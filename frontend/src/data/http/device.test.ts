import { afterEach, describe, expect, test, vi } from "vitest";
import { device } from "./device";

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
  vi.unstubAllGlobals();
});

describe("what the device keeps", () => {
  test("reads back what it wrote", async () => {
    useStorage(new MemoryStorage());
    await device.ready;
    expect(device.suggestedLocale).toBeNull();
    device.set("evermind:draft:c1", "Hello.");
    expect(device.get("evermind:draft:c1")).toBe("Hello.");
    expect(device.get("evermind:draft:c2")).toBeNull();
    device.remove("evermind:draft:c1");
    expect(device.get("evermind:draft:c1")).toBeNull();
  });

  test("lists the keys under a prefix only", () => {
    useStorage(new MemoryStorage());
    device.set("evermind:draft:c1", "one");
    device.set("evermind:sending:c1", "{}");
    device.set("evermind:draft:c2", "two");
    device.set("evermind:locale", "fr");
    expect(device.keys("evermind:draft:").sort()).toEqual(["evermind:draft:c1", "evermind:draft:c2"]);
    expect(device.keys("nothing:")).toEqual([]);
  });

  test("a store that throws reads as empty and writes nothing", () => {
    blockStorage();
    expect(() => device.set("evermind:draft:c1", "words")).not.toThrow();
    expect(() => device.remove("evermind:draft:c1")).not.toThrow();
    expect(device.get("evermind:draft:c1")).toBeNull();
    expect(device.keys("evermind:")).toEqual([]);

    const full = new MemoryStorage();
    full.setItem = () => {
      throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
    };
    useStorage(full);
    expect(() => device.set("evermind:draft:c1", "words")).not.toThrow();
    expect(device.get("evermind:draft:c1")).toBeNull();
    expect(device.keys("evermind:")).toEqual([]);
  });

  test("tells of a change made in another window, with what the key held before, and stops when asked", () => {
    // Node has no window: one is put where the page's own would be.
    const page = new EventTarget();
    vi.stubGlobal("addEventListener", page.addEventListener.bind(page));
    vi.stubGlobal("removeEventListener", page.removeEventListener.bind(page));
    const storageEvent = (key: string | null, oldValue: string | null, newValue: string | null) =>
      Object.assign(new Event("storage"), { key, oldValue, newValue });

    const heard: [string, string | null, string | null][] = [];
    const stop = device.onChange((key, oldValue, newValue) => heard.push([key, oldValue, newValue]));
    page.dispatchEvent(storageEvent("evermind:sending:c1", '{"clientId":"x"}', null));
    // Everything cleared at once names no key: there is nothing to tell of.
    page.dispatchEvent(storageEvent(null, null, null));
    expect(heard).toEqual([["evermind:sending:c1", '{"clientId":"x"}', null]]);

    stop();
    page.dispatchEvent(storageEvent("evermind:sending:c2", "{}", null));
    expect(heard).toHaveLength(1);
  });
});
