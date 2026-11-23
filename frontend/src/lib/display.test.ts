import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Character, Conversation } from "@/types";

const frontend = fileURLToPath(new URL("../..", import.meta.url));

/** A device store that keeps what it is given in a map, and tells the listener a change came in. */
function fakeDevice(options: { shared?: boolean; broken?: boolean } = {}) {
  const kept = new Map<string, string>();
  const listeners: ((key: string, oldValue: string | null, newValue: string | null) => void)[] = [];
  const broken = () => {
    throw new Error("storage is not allowed");
  };
  return {
    kept,
    listeners,
    device: {
      ready: Promise.resolve(),
      suggestedLocale: null,
      sharedAcrossDevices: options.shared,
      get: options.broken ? broken : (key: string) => kept.get(key) ?? null,
      set: options.broken ? broken : (key: string, value: string) => void kept.set(key, value),
      remove: (key: string) => void kept.delete(key),
      keys: (prefix: string) => [...kept.keys()].filter((key) => key.startsWith(prefix)),
      onChange(listener: (key: string, oldValue: string | null, newValue: string | null) => void) {
        listeners.push(listener);
        return () => void listeners.splice(listeners.indexOf(listener), 1);
      },
    },
  };
}

let store = fakeDevice();

vi.mock("@/data", () => ({ data: { get device() { return store.device; } } }));

// The module keeps what it read in memory for the life of the page: each test starts a page.
async function load() {
  vi.resetModules();
  return import("./display");
}

beforeEach(() => {
  store = fakeDevice();
  Reflect.deleteProperty(globalThis, "matchMedia");
});

describe("what is read", () => {
  test("nothing stored reads as the defaults", async () => {
    const { DISPLAY_DEFAULTS, getDisplay, readDisplay } = await load();
    expect(DISPLAY_DEFAULTS).toEqual({ text: 1, portrait: true, strength: 0.2 });
    expect(readDisplay(null)).toEqual(DISPLAY_DEFAULTS);
    expect(getDisplay()).toEqual(DISPLAY_DEFAULTS);
  });

  test("each field is judged alone", async () => {
    const { readDisplay } = await load();
    expect(readDisplay('{"text": 9, "portrait": "yes", "strength": 0.5}')).toEqual({
      text: 2, portrait: true, strength: 0.5,
    });
    expect(readDisplay('{"portrait": false}')).toEqual({ text: 1, portrait: false, strength: 0.2 });
    expect(readDisplay('{"text": "big", "strength": null}')).toEqual({ text: 1, portrait: true, strength: 0.2 });
    expect(readDisplay('{"text": 0.1, "strength": -3}')).toEqual({ text: 0.8, portrait: true, strength: 0 });
    expect(readDisplay('{"strength": 7}').strength).toBe(1);
  });

  test("a portrait that is not a boolean takes its default, falsy or not", async () => {
    const { readDisplay } = await load();
    for (const raw of ['{"portrait": 0}', '{"portrait": ""}', '{"portrait": null}', '{"portrait": 1}'])
      expect(readDisplay(raw).portrait).toBe(true);
  });

  test("a number that is not finite takes its default", async () => {
    const { DISPLAY_DEFAULTS, readDisplay } = await load();
    // JSON.parse reads 1e999 as Infinity.
    expect(readDisplay('{"text": 1e999, "strength": -1e999}')).toEqual(DISPLAY_DEFAULTS);
  });

  test("a text scale snaps to five percent", async () => {
    const { readDisplay } = await load();
    expect(readDisplay('{"text": 1.234}').text).toBe(1.25);
    expect(readDisplay('{"text": 0.81}').text).toBe(0.8);
    expect(readDisplay('{"text": 1.98}').text).toBe(2);
  });

  test("garbage reads as the defaults", async () => {
    const { DISPLAY_DEFAULTS, readDisplay } = await load();
    for (const raw of ["{", "null", "[]", "3", '"text"', ""]) expect(readDisplay(raw)).toEqual(DISPLAY_DEFAULTS);
  });
});

describe("what is kept", () => {
  test("a change is written, heard by the listeners, and read back on the next page", async () => {
    const first = await load();
    const heard = vi.fn();
    first.subscribeDisplay(heard);
    first.setDisplay({ text: 1.5 });
    expect(first.getDisplay()).toEqual({ text: 1.5, portrait: true, strength: 0.2 });
    expect(heard).toHaveBeenCalledTimes(1);
    expect(JSON.parse(store.kept.get("evermind:display")!)).toEqual({ text: 1.5, portrait: true, strength: 0.2 });

    const next = await load();
    expect(next.getDisplay().text).toBe(1.5);
  });

  test("a change is held to the same bounds as a read", async () => {
    const { getDisplay, setDisplay } = await load();
    setDisplay({ text: 5, strength: -1 });
    expect(getDisplay()).toEqual({ text: 2, portrait: true, strength: 0 });
  });

  test("a number that is not finite is not kept, as a bad slider value would send it", async () => {
    const { getDisplay, setDisplay } = await load();
    setDisplay({ text: NaN, strength: Infinity });
    expect(getDisplay()).toEqual({ text: 1, portrait: true, strength: 0.2 });
    expect(JSON.parse(store.kept.get("evermind:display")!)).toEqual({ text: 1, portrait: true, strength: 0.2 });
  });

  test("a store that throws reads as the defaults and keeps a change in memory", async () => {
    store = fakeDevice({ broken: true });
    const { DISPLAY_DEFAULTS, getDisplay, setDisplay } = await load();
    expect(getDisplay()).toEqual(DISPLAY_DEFAULTS);
    expect(() => setDisplay({ text: 1.4, portrait: false })).not.toThrow();
    expect(getDisplay()).toEqual({ text: 1.4, portrait: false, strength: 0.2 });
  });

  test("a change from another window is heard", async () => {
    const { getDisplay, subscribeDisplay } = await load();
    const heard = vi.fn();
    subscribeDisplay(heard);
    expect(getDisplay().text).toBe(1);
    expect(store.listeners).toHaveLength(1);

    store.listeners[0]("evermind:display:other", null, '{"text": 1.1}');
    expect(getDisplay().text).toBe(1);
    expect(heard).not.toHaveBeenCalled();

    store.listeners[0]("evermind:display", null, '{"text": 1.6, "portrait": false}');
    expect(getDisplay()).toEqual({ text: 1.6, portrait: false, strength: 0.2 });
    expect(heard).toHaveBeenCalledTimes(1);

    // The key gone: the defaults again.
    store.listeners[0]("evermind:display", '{"text": 1.6}', null);
    expect(getDisplay().text).toBe(1);
  });

  test("the listener that stopped listening is no longer called", async () => {
    const { setDisplay, subscribeDisplay } = await load();
    const heard = vi.fn();
    const stop = subscribeDisplay(heard);
    stop();
    setDisplay({ text: 1.2 });
    expect(heard).not.toHaveBeenCalled();
  });

  test("a store shared across devices keeps one display per kind of screen", async () => {
    const { displayKey } = await load();
    expect(displayKey({ sharedAcrossDevices: undefined }, true)).toBe("evermind:display");
    expect(displayKey({ sharedAcrossDevices: false }, false)).toBe("evermind:display");
    expect(displayKey({ sharedAcrossDevices: true }, true)).toBe("evermind:display:touch");
    expect(displayKey({ sharedAcrossDevices: true }, false)).toBe("evermind:display:desk");

    // And the page reads and writes under the key of its own screen.
    store = fakeDevice({ shared: true });
    store.kept.set("evermind:display:touch", '{"text": 1.3}');
    store.kept.set("evermind:display:desk", '{"text": 0.9}');
    globalThis.matchMedia = ((query: string) => ({ matches: query === "(pointer: coarse)" })) as typeof matchMedia;
    const phone = await load();
    expect(phone.getDisplay().text).toBe(1.3);
    phone.setDisplay({ text: 1.4 });
    expect(JSON.parse(store.kept.get("evermind:display:touch")!).text).toBe(1.4);
    expect(JSON.parse(store.kept.get("evermind:display:desk")!).text).toBe(0.9);
  });
});

describe("what is drawn from it", () => {
  test("the plate keeps the picture at twelve percent under the text", async () => {
    const { UNDER_TEXT, plateAlpha } = await load();
    expect(UNDER_TEXT).toBe(0.12);
    expect(plateAlpha(0.1)).toBe(0);
    expect(plateAlpha(0.12)).toBe(0);
    expect(plateAlpha(0.2)).toBeCloseTo(0.4, 12);
    expect(plateAlpha(1)).toBeCloseTo(0.88, 12);
    for (let hundredths = 0; hundredths <= 100; hundredths++) {
      const strength = hundredths / 100;
      expect(strength * (1 - plateAlpha(strength))).toBeLessThanOrEqual(0.12 + 1e-9);
    }
  });

  test("the input stops at one hundred and thirty percent", async () => {
    const { INPUT_SCALE_MAX, TEXT_SCALE, inputScale } = await load();
    expect(INPUT_SCALE_MAX).toBe(1.3);
    expect(TEXT_SCALE).toEqual({ min: 0.8, max: 2, step: 0.05 });
    expect(inputScale(0.8)).toBe(0.8);
    expect(inputScale(1.3)).toBe(1.3);
    expect(inputScale(2)).toBe(1.3);
  });
});

describe("which backdrop is drawn", () => {
  const shown = { text: 1, portrait: true, strength: 0.2 };
  const conversation = (own: Partial<Conversation> = {}) =>
    ({ backdrop: "auto", backdrop_strength: null, wallpaper_url: null, ...own }) as Pick<
      Conversation, "backdrop" | "backdrop_strength" | "wallpaper_url">;
  const portrait = (own: Partial<Character> = {}) =>
    ({ avatar_url: "/media/full.png", avatar_backdrop_url: "/media/960.webp", ...own }) as Pick<
      Character, "avatar_url" | "avatar_backdrop_url">;
  const nothing = { src: null, fallback: null, kind: null };

  test("a picture the person chose is drawn as it is", async () => {
    const { backdropOf } = await load();
    expect(backdropOf(conversation({ backdrop: "image", wallpaper_url: "/media/wall.jpg" }), portrait(), shown)).toEqual({
      src: "/media/wall.jpg", fallback: null, kind: "image", strength: 0.2, own: false,
    });
  });

  test("a picture chosen but with no file draws nothing, not the portrait", async () => {
    const { backdropOf } = await load();
    expect(backdropOf(conversation({ backdrop: "image" }), portrait(), shown)).toMatchObject(nothing);
  });

  test("the portrait is drawn by its copy, and by itself where the copy fails", async () => {
    const { backdropOf } = await load();
    expect(backdropOf(conversation(), portrait(), shown)).toMatchObject({
      src: "/media/960.webp", fallback: "/media/full.png", kind: "portrait",
    });
  });

  test("a portrait with no copy is drawn whole, with nothing to fall back on", async () => {
    const { backdropOf } = await load();
    expect(backdropOf(conversation(), portrait({ avatar_backdrop_url: null }), shown)).toMatchObject({
      src: "/media/full.png", fallback: null, kind: "portrait",
    });
  });

  test("a device that hides pictures draws none of the portrait", async () => {
    const { backdropOf } = await load();
    expect(backdropOf(conversation(), portrait(), { ...shown, portrait: false })).toMatchObject(nothing);
    // The picture of the conversation is its own choice: the device's switch is about portraits.
    expect(backdropOf(conversation({ backdrop: "image", wallpaper_url: "/w.jpg" }), portrait(), { ...shown, portrait: false }))
      .toMatchObject({ src: "/w.jpg", kind: "image" });
  });

  test("no backdrop, and a card with no picture, draw nothing", async () => {
    const { backdropOf } = await load();
    expect(backdropOf(conversation({ backdrop: "none" }), portrait(), shown)).toMatchObject(nothing);
    expect(backdropOf(conversation(), portrait({ avatar_url: null, avatar_backdrop_url: null }), shown)).toMatchObject(nothing);
    expect(backdropOf(conversation(), undefined, shown)).toMatchObject(nothing);
  });

  test("the strength is the conversation's own, or else the device's", async () => {
    const { backdropOf } = await load();
    expect(backdropOf(conversation(), portrait(), shown)).toMatchObject({ strength: 0.2, own: false });
    expect(backdropOf(conversation({ backdrop_strength: 0.7 }), portrait(), shown)).toMatchObject({ strength: 0.7, own: true });
    // An own strength of zero is a strength, not an absence.
    expect(backdropOf(conversation({ backdrop_strength: 0 }), portrait(), shown)).toMatchObject({ strength: 0, own: true });
  });
});

describe("reading over a backdrop", () => {
  const css = readFileSync(`${frontend}/src/styles.css`, "utf8");
  const colour = (name: string) => {
    const hex = new RegExp(`--color-${name}:\\s*#([0-9a-f]{6})`, "i").exec(css)?.[1];
    if (!hex) throw new Error(`no colour ${name} in styles.css`);
    return [0, 2, 4].map((at) => parseInt(hex.slice(at, at + 2), 16));
  };
  const luminance = (rgb: number[]) => {
    const [r, g, b] = rgb.map((channel) => {
      const c = channel / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a: number[], b: number[]) => {
    const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (high + 0.05) / (low + 0.05);
  };
  // The page under the text is at worst its own colour with a white picture weighing 12 % on it.
  const page = colour("ink-950").map((channel) => channel * 0.88 + 255 * 0.12);

  test("every text colour drawn over a backdrop reads at 4.5:1 or more on a white picture", () => {
    for (const name of ["parchment", "parchment-dim", "ember-300", "arcane-300", "mist"])
      expect(contrast(colour(name), page), name).toBeGreaterThanOrEqual(4.5);
    // Out of the game, the message sits on a plain surface.
    expect(contrast(colour("mist"), colour("ink-900"))).toBeGreaterThanOrEqual(4.5);
  });

  test("the quietest grey does not, which is why it is raised on a backdrop", () => {
    expect(contrast(colour("mist-dim"), page)).toBeLessThan(4.5);
  });

  test("the page colour is one variable the plate takes, as the page's own", () => {
    expect(css).toMatch(/--page-rgb:\s*15 13 18;/);
    expect(colour("ink-950")).toEqual([15, 13, 18]);
  });
});
