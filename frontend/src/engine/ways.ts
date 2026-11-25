// The ways of playing, step for step backend/app/prompting/ways.py: how much of the story a
// conversation rereads, how long its replies run, and how much room the reminders (facts,
// lorebook, past passages) take. "balanced" is the engine as it was before ways existed.

export type Length = "short" | "medium" | "long";
export type Level = "essential" | "normal" | "rich" | "all";

/** The six fields that size the reminders. null: no cap, or no share. */
export interface ReminderFields {
  facts_cap: number | null;
  max_facts: number | null;
  lore_cap: number | null;
  lore_share: number | null;
  passage_cap: number | null;
  passage_share: number | null;
}

export interface WayFields extends ReminderFields {
  /** 0: the whole story. */
  history_limit: number;
  reply_length: Length;
  /** null: the room is left to the AI. */
  reply_room: number | null;
}

export interface Way extends WayFields {
  id: string;
  name: string | null;
  built_in: boolean;
  overridden: boolean;
}

/** What settings.play_styles keeps: the edits of a built-in way, and the ways a person made. */
export interface PlayStyles {
  overrides?: Record<string, Partial<WayFields>> | null;
  custom?: (Partial<WayFields> & { id: string; name?: string | null })[] | null;
}

export interface PlayOverrides {
  history_limit?: number | null;
  reply_length?: string | null;
  reminders?: string | null;
}

export const FIELDS = [
  "history_limit",
  "reply_length",
  "reply_room",
  "facts_cap",
  "max_facts",
  "lore_cap",
  "lore_share",
  "passage_cap",
  "passage_share",
] as const;
export const REMINDER_FIELDS = [
  "facts_cap",
  "max_facts",
  "lore_cap",
  "lore_share",
  "passage_cap",
  "passage_share",
] as const;
export const REPLY_ROOM: Readonly<Record<Length, number>> = { short: 512, medium: 1024, long: 2048 };

export const LEVELS: Readonly<Record<Level, Readonly<ReminderFields>>> = {
  essential: {
    facts_cap: 700,
    max_facts: 60,
    lore_cap: 400,
    lore_share: 0.06,
    passage_cap: 0,
    passage_share: null,
  },
  // What the engine always gave: 2000 tokens of facts at most, 60 facts, 800 of lorebook, 1500
  // of past passages.
  normal: {
    facts_cap: 2000,
    max_facts: 60,
    lore_cap: 800,
    lore_share: null,
    passage_cap: 1500,
    passage_share: null,
  },
  rich: {
    facts_cap: 4000,
    max_facts: 120,
    lore_cap: 1600,
    lore_share: 0.06,
    passage_cap: 3000,
    passage_share: 0.1,
  },
  all: {
    facts_cap: null,
    max_facts: null,
    lore_cap: null,
    lore_share: 0.06,
    passage_cap: null,
    passage_share: 0.1,
  },
};

export const BUILT_IN: Readonly<Record<string, Readonly<WayFields>>> = {
  light: { history_limit: 16, reply_length: "short", reply_room: 512, ...LEVELS.essential },
  balanced: { history_limit: 24, reply_length: "medium", reply_room: 1024, ...LEVELS.normal },
  immersive: { history_limit: 60, reply_length: "long", reply_room: 2048, ...LEVELS.rich },
  // Immersive that rereads the whole story (0: no limit).
  maximum: { history_limit: 0, reply_length: "long", reply_room: 2048, ...LEVELS.rich },
};

const FACTS_FLOOR = 700;
const FACTS_SHARE = 0.12;

// No way given: the engine's figures from before ways existed.
const FACTS_CAP_BEFORE = 2000;
const MAX_FACTS_BEFORE = 60;
const LORE_BEFORE = 800;
const PASSAGES_BEFORE = 1500;

/** Python's `int()` of a number: no -0, which a strict comparison tells from 0. */
const int = (n: number) => Math.trunc(n) + 0;

// Own keys only, as a Python dict reads them: an id such as "constructor" is no way.
const own = <T>(record: Record<string, T> | null | undefined, key: string): T | undefined =>
  record && Object.hasOwn(record, key) ? record[key] : undefined;

// The largest whole number JSON and JavaScript both hold exactly.
const WHOLE = 2 ** 53 - 1;
// What each field may hold, as the API takes it: [least whole number, null allowed], or "share"
// (a number from 0 to 1, or null), or "length".
const KINDS: Readonly<Record<(typeof FIELDS)[number], readonly [number, boolean] | "share" | "length">> = {
  history_limit: [0, false],
  reply_length: "length",
  reply_room: [1, true],
  facts_cap: [0, true],
  max_facts: [1, true],
  lore_cap: [0, true],
  lore_share: "share",
  passage_cap: [0, true],
  passage_share: "share",
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether a stored value is what the field holds: one written by hand may be anything. */
function readable(field: (typeof FIELDS)[number], value: unknown): boolean {
  const kind = KINDS[field];
  if (kind === "length") return isLength(value);
  if (value === null) return kind === "share" || kind[1];
  if (typeof value !== "number") return false;
  if (kind === "share") return value >= 0 && value <= 1;
  return Number.isInteger(value) && value >= kind[0] && value <= WHOLE;
}

/** The fields of what was stored that a way can play; any other is left out. */
function picked(stored: unknown): Partial<WayFields> {
  const fields: Record<string, unknown> = {};
  if (!isRecord(stored)) return fields as Partial<WayFields>;
  for (const field of FIELDS) {
    if (Object.hasOwn(stored, field) && readable(field, stored[field])) fields[field] = stored[field];
  }
  return fields as Partial<WayFields>;
}

function found(playStyles: PlayStyles, wayId: string | null | undefined): Way | null {
  if (wayId == null) return null;
  const original = own(BUILT_IN, wayId);
  if (original) {
    // An edit that cannot be played is no edit: the way keeps its own value.
    const overrides: unknown = playStyles.overrides;
    const edits = picked(isRecord(overrides) ? own(overrides, wayId) : undefined);
    const overridden = Object.entries(edits).some(
      ([field, value]) => original[field as keyof WayFields] !== value,
    );
    return { id: wayId, name: null, built_in: true, overridden, ...original, ...edits };
  }
  const customs: unknown = playStyles.custom;
  for (const custom of Array.isArray(customs) ? (customs as unknown[]) : []) {
    if (isRecord(custom) && custom.id === wayId) {
      // A field missing from what was stored, or one that cannot be played, plays as balanced,
      // never as nothing.
      return {
        id: wayId,
        name: typeof custom.name === "string" ? custom.name : null,
        built_in: false,
        overridden: false,
        ...BUILT_IN.balanced,
        ...picked(custom),
      };
    }
  }
  return null;
}

/** A built-in way with its stored edits merged (only the fields stored), else a custom way; an
 *  unknown id resolves to defaultId, then to "balanced". name is null for a built-in and for
 *  "mine". */
export function wayOf(
  playStyles: PlayStyles | null | undefined,
  wayId: string | null | undefined,
  defaultId: string | null | undefined,
): Way {
  const styles: PlayStyles = isRecord(playStyles) ? playStyles : {};
  return (found(styles, wayId) ?? found(styles, defaultId) ?? found(styles, "balanced")) as Way;
}

/** The level whose six fields all equal these, else null. */
export function levelOf(fields: Partial<ReminderFields>): Level | null {
  for (const [level, values] of Object.entries(LEVELS) as [Level, ReminderFields][]) {
    if (REMINDER_FIELDS.every((field) => (fields[field] ?? null) === values[field])) return level;
  }
  return null;
}

const isLength = (value: unknown): value is Length =>
  typeof value === "string" && Object.hasOwn(REPLY_ROOM, value);
const isLevel = (value: unknown): value is Level => typeof value === "string" && Object.hasOwn(LEVELS, value);

/** The way with a conversation's overrides: history_limit as is; reply_length with its room;
 *  reminders replaces the six reminder fields by those of its level. `adjusted` is true when at
 *  least one override differs from the way's own value. An override equal to the way's value,
 *  or one that cannot be read, changes nothing. */
export function applied<W extends WayFields>(way: W, overrides: PlayOverrides | null | undefined): W & { adjusted: boolean } {
  const result: W = { ...way };
  let adjusted = false;
  const limit = overrides?.history_limit;
  if (typeof limit === "number" && Number.isInteger(limit) && limit !== way.history_limit) {
    result.history_limit = limit;
    adjusted = true;
  }
  const length = overrides?.reply_length;
  if (isLength(length) && length !== way.reply_length) {
    result.reply_length = length;
    result.reply_room = REPLY_ROOM[length];
    adjusted = true;
  }
  const level = overrides?.reminders;
  if (isLevel(level) && level !== levelOf(way)) {
    Object.assign(result, LEVELS[level]);
    adjusted = true;
  }
  return { ...result, adjusted };
}

/** The way a conversation plays, its own overrides applied; null: the way offered to new
 *  conversations, unadjusted. */
export function wayFor(
  conversation: { play_style?: string | null; play_overrides?: PlayOverrides | null } | null,
  settings: { play_styles?: PlayStyles | null; default_play_style?: string | null },
): Way & { adjusted: boolean } {
  const way = wayOf(settings.play_styles, conversation?.play_style, settings.default_play_style);
  return applied(way, conversation?.play_overrides);
}

/** The smaller of a cap and a share of the budget, for those given; neither: the budget. */
function smaller(cap: number | null, share: number | null, budget: number): number {
  const bounds = [cap, share === null ? null : int(budget * share)].filter((b): b is number => b !== null);
  return bounds.length ? Math.min(...bounds) : budget;
}

export function factsBudget(reminders: ReminderFields | null, budget: number): number {
  if (reminders === null) return Math.min(FACTS_CAP_BEFORE, Math.max(FACTS_FLOOR, int(budget * FACTS_SHARE)));
  const room = Math.max(FACTS_FLOOR, int(budget * FACTS_SHARE));
  return reminders.facts_cap === null ? room : Math.min(room, reminders.facts_cap);
}

/** How many facts at most; null: as many as fit. */
export function maxFacts(reminders: ReminderFields | null): number | null {
  return reminders === null ? MAX_FACTS_BEFORE : reminders.max_facts;
}

/** The lorebook of a card on Evermind's own rules. A community card's keeps its quarter of the
 *  budget whatever the way (chat.ts). */
export function loreBudget(reminders: ReminderFields | null, budget: number): number {
  return reminders === null ? LORE_BEFORE : smaller(reminders.lore_cap, reminders.lore_share, budget);
}

export function passageBudget(reminders: ReminderFields | null, budget: number): number {
  return reminders === null ? PASSAGES_BEFORE : smaller(reminders.passage_cap, reminders.passage_share, budget);
}

/** Python's `round()` of a float: to the nearest whole number, a half to the even one. */
export function roundHalfEven(x: number): number {
  const floor = Math.floor(x);
  // Exact: a double and its floor share their exponent's range.
  const rest = x - floor;
  if (rest > 0.5) return floor + 1 + 0;
  if (rest < 0.5) return floor + 0;
  return (floor % 2 === 0 ? floor : floor + 1) + 0;
}

export interface Parts {
  card: number;
  reminders: number;
  history: number;
}

export interface OutlookStats {
  used_tokens: number;
  budget: number;
  context_size: number;
  messages_included: number;
  messages_total: number;
  parts: Parts;
}

export interface OutlookEntry {
  used_tokens: number;
  budget: number;
  context_size: number;
  messages_included: number;
  messages_total: number;
  history_limit: number;
  reply_room: number;
  parts: Parts;
  cap_short: number | null;
}

/** What a prompt built ahead of a turn says, in the server's tokens: the engine counts in
 *  estimated ones, which the measured ratio turns into the server's. */
export function outlookEntry(
  stats: OutlookStats,
  ratio: number,
  historyLimit: number,
  replyRoom: number,
  capShort: number | null,
): OutlookEntry {
  const counted = (n: number) => roundHalfEven(n * ratio);
  return {
    used_tokens: counted(stats.used_tokens),
    budget: counted(stats.budget),
    context_size: stats.context_size,
    messages_included: stats.messages_included,
    messages_total: stats.messages_total,
    history_limit: historyLimit,
    reply_room: replyRoom,
    parts: {
      card: counted(stats.parts.card),
      reminders: counted(stats.parts.reminders),
      history: counted(stats.parts.history),
    },
    cap_short: capShort,
  };
}

/** One passage that costs the given budget, so that an outlook counts the past passages a turn
 *  may add without searching for them. The shortest text of that cost. */
export function standInPassages(tokens: number): { role: string; position: number; content: string }[] {
  if (tokens <= 0) return [];
  // estimateTokens(n characters) is trunc(n / 3.5) + 1: the least n giving t is 3.5 (t - 1)
  // rounded up, and 1 for t = 1 (an empty text costs nothing).
  const length = Math.max(1, Math.floor((7 * (tokens - 1) + 1) / 2));
  return [{ role: "user", position: 0, content: "x".repeat(length) }];
}
