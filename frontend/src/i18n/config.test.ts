import { data } from "@/data";
import { blockStorage, MemoryStorage, useStorage } from "@/lib/storage.fake";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { initialLocale, LOCALE_COOKIE, LOCALE_STORAGE_KEY } from "./config";

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
