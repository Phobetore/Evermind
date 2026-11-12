import { data } from "@/data";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { initialLocale, LOCALE_COOKIE, LOCALE_STORAGE_KEY } from "./config";

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

// The store's suggestion is read-only to the interface; the host is what would set it.
const device = data.device as { suggestedLocale: string | null };

function suggest(locale: string | null) {
  device.suggestedLocale = locale;
}

function browser({ cookie = "", languages = ["en-US"] }: { cookie?: string; languages?: string[] }) {
  vi.stubGlobal("document", { cookie });
  vi.stubGlobal("navigator", { languages, language: languages[0] });
}

beforeEach(() => {
  useStorage(new MemoryStorage());
  browser({});
});

afterEach(() => {
  suggest(null);
  vi.unstubAllGlobals();
  Reflect.deleteProperty(globalThis, "localStorage");
});

describe("the language to open in", () => {
  test("the language chosen on this device beats the one the host suggests", () => {
    globalThis.localStorage.setItem(LOCALE_STORAGE_KEY, "de");
    suggest("fr");
    expect(initialLocale()).toBe("de");
  });

  test("a suggestion with a region is taken as its language", () => {
    suggest("fr-FR");
    expect(initialLocale()).toBe("fr");
  });

  test("a suggested language that is not offered falls through to the cookie, then the browser", () => {
    suggest("pt-BR");
    browser({ cookie: `${LOCALE_COOKIE}=es`, languages: ["de-DE"] });
    expect(initialLocale()).toBe("es");
    browser({ languages: ["pt-BR", "de-DE"] });
    expect(initialLocale()).toBe("de");
  });

  test("a store that cannot be read opens in the language the host suggests", () => {
    blockStorage();
    suggest("fr");
    browser({ cookie: `${LOCALE_COOKIE}=es`, languages: ["de-DE"] });
    expect(initialLocale()).toBe("fr");
  });
});
