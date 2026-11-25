// What an AI would read of a long story under a way, and what 100 of its messages would cost: one
// rule, so that the figure is the same wherever an AI or a way is chosen. Never under the input of
// a conversation, and never worked out by the server.

import { factsBudget, loreBudget, passageBudget, replyReserve, type ReminderFields } from "@/engine";
import type { Translate as T } from "@/i18n/I18nProvider";
import type { Ai, Family, Length, ProbeModel, WayFields } from "@/types";
import { per100 } from "./money";

// No sentence is read here but through the `t` given, and nothing imports the language files: the
// browser suite, which Node runs without them, ranks rows by this very rule.

/** About 1 750 characters at the engine's 3.5 per token. */
export const PAGE_TOKENS = 500;

/** Tokens as pages: from 100 pages up to the nearest 10, which is all the figure is worth there;
 *  below, rounded and never less than one, so a small window does not read as nothing. */
export function pages(tokens: number): number {
  const exact = tokens / PAGE_TOKENS;
  return exact >= 100 ? Math.round(exact / 10) * 10 : Math.max(1, Math.round(exact));
}

/** The mockup's long story: a card of 1,700 tokens, and messages of 280. */
export const REFERENCE = { card: 1700, perMessage: 280 } as const;
/** What a reply of each length takes, until the AI's own have been measured. */
export const REPLY_GUESS: Record<Length, number> = { short: 170, medium: 450, long: 1100 };

/** USD per million tokens, the price the AI's line shows. */
export interface Pricing { input: number | null; output: number | null; free: boolean; varies: boolean; }

/** What the estimate knows of an AI, added or not yet: in the server's tokens, but `ratio`, the
 *  server's tokens for each one the engine estimates. */
export interface Reader {
  window: number;
  margin: number;
  ratio: number;
  /** What the prompt keeps for the reply under a way's room (null: left to the AI). */
  reserve(room: number | null): number;
  replyTokens: Record<Length, number | null>;
  reasons: boolean | null;
  thinkingMeasured: boolean;
  /** null: no AI, or an edition with no AIs of its own. */
  pricing: Pricing | null;
}

/** As the server's reserve reads it: 1 for a model that reasons, 0 for one that does not, null
 *  while nothing has said. */
const reasonsOf = (reasons: boolean | null) => (reasons === null ? null : Number(reasons));

export function readerOfAi(ai: Ai): Reader {
  const model = {
    reply_cap_mode: ai.reply_cap.mode,
    reply_cap_tokens: ai.reply_cap.tokens,
    reasons: reasonsOf(ai.reasons),
    output_read: ai.output_read,
  };
  return {
    window: ai.context.used,
    margin: ai.margin,
    ratio: ai.token_ratio ?? 1,
    reserve: (room) => replyReserve(model, ai.service.family, ai.anthropic, room, ai.context.used, ai.thinking_allowance),
    replyTokens: ai.reply_tokens,
    reasons: ai.reasons,
    thinkingMeasured: ai.thinking_measured,
    // The price typed wins over the price read, as the line shows it.
    pricing: {
      input: ai.price.own_in ?? ai.price.read_in,
      output: ai.price.own_out ?? ai.price.read_out,
      free: ai.free,
      varies: ai.price.varies,
    },
  };
}

/** What Evermind assumes of a size nobody told (ai_call.ASSUMED_WINDOW). */
const ASSUMED_WINDOW = 16_384;
/** The margin of an AI that has measured nothing yet: 6 % of the window, never under 200. */
const WIDE_MARGIN = 0.06;
const LEAST_MARGIN = 200;
/** The room a model that reasons is given for its thinking until a reply has measured it. */
const THINKING_ALLOWANCE = 3072;

/** A model of a service's list, not added yet: counted as an AI left to Evermind that has
 *  measured nothing, reading what its line says it reads. */
export function readerOfRow(row: ProbeModel, family: Family): Reader {
  const window = row.context.served ?? row.context.configured ?? row.context.max ?? ASSUMED_WINDOW;
  const model = { reply_cap_mode: "auto" as const, reply_cap_tokens: null, reasons: reasonsOf(row.reasons), output_read: row.max_output };
  const anthropic = family === "anthropic";
  return {
    window,
    margin: Math.max(LEAST_MARGIN, Math.trunc(window * WIDE_MARGIN)),
    ratio: 1,
    reserve: (room) => replyReserve(model, family, anthropic, room, window, THINKING_ALLOWANCE),
    replyTokens: { short: null, medium: null, long: null },
    reasons: row.reasons,
    thinkingMeasured: false,
    // A row has no word of its own for free: its two prices of nothing say it (lib/ai.ts, freeOnly),
    // which estimateOf reads as free.
    pricing: { input: row.price.input, output: row.price.output, free: false, varies: row.price.varies },
  };
}

export interface Reading {
  /** In the engine's tokens, as the engine's budget is. */
  budget: number;
  used: number;
  /** What is read, in pages of the server's tokens. */
  pages: number;
  /** The messages of the reference story that fit; null for a way that rereads all. */
  reread: number | null;
  /** What the way asks to reread; null: all of it. */
  asked: number | null;
  /** The reading capacity is full before the way's messages are all read. */
  full: boolean;
  /** In the server's tokens; room is what the prompt keeps for the reply. */
  parts: { card: number; reminders: number; history: number; room: number };
}

/** The engine's floor (engine.py): the least budget a prompt is given, whatever the window. */
const ENGINE_FLOOR = 512;

const remindersOf = (way: WayFields): ReminderFields => ({
  facts_cap: way.facts_cap, max_facts: way.max_facts, lore_cap: way.lore_cap,
  lore_share: way.lore_share, passage_cap: way.passage_cap, passage_share: way.passage_share,
});

/** The reference story read by this AI under this way: the reminders at their full room, the
 *  card, then as many messages as the way asks and the budget holds. */
export function readingOf(reader: Reader, way: WayFields): Reading {
  const room = reader.reserve(way.reply_room);
  const budget = Math.max(ENGINE_FLOOR, Math.trunc((reader.window - room - reader.margin) / reader.ratio));
  const six = remindersOf(way);
  const reminders = factsBudget(six, budget) + loreBudget(six, budget) + passageBudget(six, budget);
  const history = way.history_limit;
  const used = history === 0
    ? budget
    : Math.min(budget, REFERENCE.card + reminders + history * REFERENCE.perMessage);
  const fits = Math.max(0, Math.floor((budget - REFERENCE.card - reminders) / REFERENCE.perMessage));
  const reread = history === 0 ? fits : Math.min(fits, history);
  // A way that rereads all is always full: the reference story goes on past any budget.
  const full = history > 0 ? reread < history : true;
  const server = (tokens: number) => Math.round(tokens * reader.ratio);
  // What the story did not leave the reminders and the card, they do not take.
  const card = Math.min(REFERENCE.card, used);
  const remindersRead = Math.min(reminders, used - card);
  return {
    budget,
    used,
    pages: pages(server(used)),
    reread,
    asked: history === 0 ? null : history,
    full,
    parts: { card: server(card), reminders: server(remindersRead), history: server(used - card - remindersRead), room },
  };
}

export type Estimate =
  | { kind: "free" } | { kind: "none" } | { kind: "varies" }
  /** fuller: with its thinking, for a model that reasons and has not answered yet. */
  | { kind: "amount"; per100: number; fuller: number | null };

const PER_MILLION = 1_000_000;
const MESSAGES = 100;

/** What 100 messages of the reference story would cost: what is read at the input's price, a
 *  reply of the way's length (measured, else guessed) at the output's. */
export function estimateOf(reader: Reader, way: WayFields): Estimate {
  const pricing = reader.pricing;
  if (pricing === null) return { kind: "none" };
  const { input, output } = pricing;
  // As the price line says it: a price of nothing read is free.
  if (pricing.free || (input === 0 && output === 0)) return { kind: "free" };
  if (pricing.varies) return { kind: "varies" };
  if (input === null || output === null) return { kind: "none" };
  const read = Math.round(readingOf(reader, way).used * reader.ratio);
  const reply = reader.replyTokens[way.reply_length] ?? REPLY_GUESS[way.reply_length];
  const amount = ((read * input + reply * output) * MESSAGES) / PER_MILLION;
  // Until its first reply, what its thinking takes is not known: the figure is a floor.
  const fuller = reader.reasons === true && !reader.thinkingMeasured
    ? amount + (THINKING_ALLOWANCE * output * MESSAGES) / PER_MILLION
    : null;
  return { kind: "amount", per100: amount, fuller };
}

const CENT = 0.01;

/** The estimate in a sentence: "≈ $0.28 per 100 messages". */
export function estimateText(estimate: Estimate, locale: string, t: T): string {
  switch (estimate.kind) {
    case "free":
      return t("ai.free");
    case "none":
      return t("ai.priceNone");
    case "varies":
      return t("ai.priceVaries");
  }
  const { per100: amount, fuller } = estimate;
  // Under a cent even with its thinking: two figures of nothing would only look precise.
  if (amount > 0 && (fuller ?? amount) < CENT) return t("money.underACent", { amount: per100(CENT, locale) });
  if (fuller !== null) return t("money.atLeast", { amount: per100(amount, locale), fuller: per100(fuller, locale) });
  return t("money.estimate", { amount: per100(amount, locale) });
}

/** What "Cheapest" sorts a list's row on: 100 messages under the way, with its thinking when it
 *  may reason; null without a price, sorted last. */
export function cheapestKey(row: ProbeModel, family: Family, way: WayFields): number | null {
  const estimate = estimateOf(readerOfRow(row, family), way);
  if (estimate.kind === "free") return 0;
  if (estimate.kind !== "amount") return null;
  return estimate.fuller ?? estimate.per100;
}
