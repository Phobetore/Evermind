import { substitute } from "@/engine";
// Not offered by the engine's door, which offers only what the recorded cases reach: display only.
import { describeMarkers } from "@/engine/macros";
import type { Character } from "@/types";

export function timeAgo(
  iso: string | null | undefined,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 60) return t("time.justNow");
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t("time.minutesAgo", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("time.hoursAgo", { count: hours });
  const days = Math.floor(hours / 24);
  if (days < 30) return t("time.daysAgo", { count: days });
  const months = Math.floor(days / 30);
  if (months < 12) return t("time.monthsAgo", { count: months });
  return t("time.yearsAgo", { count: Math.floor(months / 12) });
}

/** No text is made longer than this by the names put in for its markers: a length the page
 *  already draws (a dropped 15 MB JSON brings one), far below the longest string JavaScript holds.
 *  Not a card's longest text: a PNG chunk inflates up to INFLATE_BOUND. */
export const SHOWN_TEXT_BOUND = 15 * 1024 * 1024;

const BRACE = 0x7b; // "{"
const LESS = 0x3c; // "<"
const COMMA = 0x2c;
const COLON = 0x3a;
const COMMAS = ",".repeat(16);
const COLONS = ":".repeat(16);
const SEPARATORS = /[,:]+/y;

/** How many times "{{" starts in a text, two that overlap counted twice. */
function openings(text: string): number {
  let count = 0;
  for (let i = 0; i + 1 < text.length; i++) if (text.charCodeAt(i) === BRACE && text.charCodeAt(i + 1) === BRACE) count++;
  return count;
}

/** Whether putting the names in could keep the text within SHOWN_TEXT_BOUND: text.length plus,
 *  for each "{{" and each "<" of the text, the longer of the two names times (1 + k)², plus 2 for
 *  each "," and each ":" (a choice of random or pick shown as " / "); k is the greater of the
 *  counts of "{{" in charName and in userName, since the engine replaces {{char}} and {{user}}
 *  after it has put the names in, inside them too. An upper bound, counted in one pass over the
 *  text and one over each name, without the engine's patterns. */
export function namesFit(text: string, charName: string, userName: string): boolean {
  const k = Math.max(openings(charName), openings(userName));
  const perMarker = Math.max(charName.length, userName.length) * (1 + k) ** 2;
  let length = text.length;
  if (length > SHOWN_TEXT_BOUND) return false;
  // No character adds more than this: a text short enough fits without being read.
  if (length * (1 + Math.max(perMarker, 2)) <= SHOWN_TEXT_BOUND) return true;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit === LESS || (unit === BRACE && text.charCodeAt(i + 1) === BRACE)) length += perMarker;
    else if (unit === COMMA || unit === COLON) {
      // A long run of separators, the shape of a hostile choice, is measured by the regular
      // expression engine in one call: a character at a time, millions of them outlast the time
      // the page has. Only a run of sixteen or more is handed over, so short ones cost no call.
      if (text.startsWith(COMMAS, i) || text.startsWith(COLONS, i)) {
        SEPARATORS.lastIndex = i;
        SEPARATORS.test(text);
        length += 2 * (SEPARATORS.lastIndex - i);
        i = SEPARATORS.lastIndex - 1;
      } else length += 2;
    } else continue;
    // Stopped as soon as it is past: the rest of a long text would not bring it back.
    if (length > SHOWN_TEXT_BOUND) return false;
  }
  return true;
}

/** A card's markers for display, outside the conversation: comments out, every choice shown,
 *  names in. Left as written when the names would make the text too long (SHOWN_TEXT_BOUND). */
export function previewMacros(text: string, charName: string, userName: string): string {
  if (!text) return "";
  if (!namesFit(text, charName, userName)) return text;
  return describeMarkers(text, charName, userName);
}

/** A card's own text (a field of its definition, a greeting) as the model or the conversation gets
 *  it: markers described on the card rules (2), only {{char}} and {{user}} replaced on the old
 *  ones (1), where the engine leaves the other markers as written. */
export function cardText(text: string, cardRules: number, charName: string, userName: string): string {
  if (!text) return "";
  if (!namesFit(text, charName, userName)) return text;
  return cardRules === 2 ? describeMarkers(text, charName, userName) : substitute(text, charName, userName);
}

/** The first `count` code points of a text, never half of a pair. For a text drawn under
 *  line-clamp, which hides the lines past the clamp but still has the browser break every one of
 *  them. Only twice `count` units are spread, however long the text. */
export function firstCodePoints(text: string, count: number): string {
  return [...text.slice(0, 2 * count)].slice(0, count).join("");
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** A v4 UUID. Not `crypto.randomUUID`, which a page over plain HTTP, as a phone opens it, lacks. */
export function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 1
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Whether the focus is on the page itself, as when what held it has gone: a keyboard is then nowhere. */
export const nothingFocused = () => !document.activeElement || document.activeElement === document.body;

/** Whether it was copied. Not `navigator.clipboard`, which a page over plain HTTP lacks too. */
export function copyText(text: string): boolean {
  const active = document.activeElement as HTMLElement | null; // which selecting the text takes
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.top = "0";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  area.setSelectionRange(0, text.length); // iOS selects nothing otherwise
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
    active?.focus();
  }
}

/** The copy of a portrait for a small round or square picture: 480 px wide, not the whole file, which
 *  can be megabytes. The whole picture until the copy is made. */
export const smallPortrait = (character: Pick<Character, "avatar_url" | "avatar_thumb_url">) =>
  character.avatar_thumb_url ?? character.avatar_url;

/** The copy for a portrait drawn a few hundred pixels wide: 960 px, sharp on a dense screen. */
export const mediumPortrait = (character: Pick<Character, "avatar_url" | "avatar_backdrop_url">) =>
  character.avatar_backdrop_url ?? character.avatar_url;
