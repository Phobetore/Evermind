/** What this device shows: the size of the text, whether a character's picture is drawn behind a
 *  story, and how strongly. Kept per device, and read before the interface draws anything, so the
 *  first frame is already the right size. Everything that is only arithmetic lives here as a pure
 *  function, because the tests run without a page. */

import { useSyncExternalStore } from "react";
import { data } from "@/data";
import type { DeviceStore } from "@/data";
import type { Character, Conversation } from "@/types";

export interface Display {
  /** The scale of the text of a conversation: 1 is today's size. */
  text: number;
  /** Whether the character's picture is drawn behind a conversation that has no backdrop of its own. */
  portrait: boolean;
  /** How strongly, from 0 to 1. */
  strength: number;
}

export const DISPLAY_DEFAULTS: Display = { text: 1, portrait: true, strength: 0.2 };
export const TEXT_SCALE = { min: 0.8, max: 2, step: 0.05 } as const;
/** Past this the input would eat the conversation, with the keyboard open. */
export const INPUT_SCALE_MAX = 1.3;
/** Under the text, the picture never weighs more than this, whatever the strength. */
export const UNDER_TEXT = 0.12;

const KEY = "evermind:display";

/** Where this display is kept: a store shared by every device of the person keeps one per kind of screen. */
export function displayKey(device: Pick<DeviceStore, "sharedAcrossDevices">, coarse: boolean): string {
  if (!device.sharedAcrossDevices) return KEY;
  return coarse ? `${KEY}:touch` : `${KEY}:desk`;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// Rounded to hundredths after snapping: 1.15 * 20 is not a whole number in floating point.
function snapText(text: number): number {
  const snapped = Math.round(clamp(text, TEXT_SCALE.min, TEXT_SCALE.max) / TEXT_SCALE.step) * TEXT_SCALE.step;
  return Math.round(snapped * 100) / 100;
}

/** Each field is judged alone: one that is missing or of the wrong kind falls back to its own default
 *  and the others are kept. */
function sanitize(source: Partial<Record<keyof Display, unknown>>): Display {
  return {
    text: finite(source.text) ? snapText(source.text) : DISPLAY_DEFAULTS.text,
    portrait: typeof source.portrait === "boolean" ? source.portrait : DISPLAY_DEFAULTS.portrait,
    strength: finite(source.strength) ? clamp(source.strength, 0, 1) : DISPLAY_DEFAULTS.strength,
  };
}

export function readDisplay(raw: string | null): Display {
  if (raw === null) return { ...DISPLAY_DEFAULTS };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return sanitize(parsed);
  } catch {
    /* not JSON: it reads as nothing kept */
  }
  return { ...DISPLAY_DEFAULTS };
}

// What this page shows, once read. Replaced, never changed in place: React compares it by identity.
let current: Display | null = null;
let key = KEY;
let hearing: (() => void) | null = null;
const listeners = new Set<() => void>();

function tell() {
  for (const listener of [...listeners]) listener();
}

export function getDisplay(): Display {
  if (current) return current;
  const coarse = globalThis.matchMedia?.("(pointer: coarse)")?.matches ?? false;
  key = displayKey(data.device, coarse);
  let raw: string | null = null;
  try {
    raw = data.device.get(key);
  } catch {
    /* a store that cannot be read has kept nothing */
  }
  current = readDisplay(raw);
  // Another window of the same site changed it.
  hearing ??= data.device.onChange((changed, _before, now) => {
    if (changed !== key) return;
    current = readDisplay(now);
    tell();
  });
  return current;
}

export function setDisplay(change: Partial<Display>): void {
  current = sanitize({ ...getDisplay(), ...change });
  tell();
  try {
    data.device.set(key, JSON.stringify(current));
  } catch {
    /* the change stays for as long as the page lives */
  }
}

export function subscribeDisplay(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function useDisplay(): Display {
  // The third reader is for a page drawn without a browser (a test): the same display.
  return useSyncExternalStore(subscribeDisplay, getDisplay, getDisplay);
}

/** How opaque the page-coloured plate over the picture is, for the picture to weigh at most
 *  `UNDER_TEXT` under the text: the picture at strength `s` through a plate of alpha `a` weighs
 *  `s * (1 - a)`. */
export function plateAlpha(strength: number): number {
  return strength > UNDER_TEXT ? 1 - UNDER_TEXT / strength : 0;
}

export function inputScale(text: number): number {
  return Math.min(text, INPUT_SCALE_MAX);
}

export interface ShownBackdrop {
  /** What to draw, and what to draw when it fails; null: nothing. */
  src: string | null;
  fallback: string | null;
  kind: "portrait" | "image" | null;
  strength: number;
  /** Whether the strength is the conversation's own. */
  own: boolean;
}

export function backdropOf(
  conversation: Pick<Conversation, "backdrop" | "backdrop_strength" | "wallpaper_url">,
  character: Pick<Character, "avatar_url" | "avatar_backdrop_url"> | undefined,
  display: Display,
): ShownBackdrop {
  const own = conversation.backdrop_strength !== null;
  const strength = conversation.backdrop_strength ?? display.strength;
  const drawn = (src: string | null, fallback: string | null, kind: ShownBackdrop["kind"]) =>
    ({ src, fallback, kind, strength, own });

  // A picture chosen by hand without its file draws nothing: it does not hand over to the portrait.
  if (conversation.backdrop === "image")
    return conversation.wallpaper_url ? drawn(conversation.wallpaper_url, null, "image") : drawn(null, null, null);
  if (conversation.backdrop === "auto" && display.portrait && character?.avatar_url) {
    const copy = character.avatar_backdrop_url;
    return copy ? drawn(copy, character.avatar_url, "portrait") : drawn(character.avatar_url, null, "portrait");
  }
  return drawn(null, null, null);
}
