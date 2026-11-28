// How the page reads a period of Spending and writes what was spent: one rule for the page and for
// every line that leads to it. Days are the device's own; the source tells the server its zone.

import { data, type Cut, type DataSource } from "@/data";
import type { Translate as T } from "@/i18n/I18nProvider";
import type { Spending } from "@/types";
import { per100 } from "./money";
import { dayMonth } from "./utils";

export { zoneOfDevice } from "@/data/http/zone";
export type { Cut };

export type Period = "7" | "30" | "month" | "last" | "all";

/** The periods, in the order the page offers them. */
export const PERIODS: readonly string[] = ["7", "30", "month", "last", "all"] satisfies Period[];

/** The days the server reads (FIRST_DAY and LAST_DAY of backend/app/services/periods.py): a date
 *  field keeps within them. */
export const FIRST_DAY = "2000-01-01";
export const LAST_DAY = "2100-12-31";
const PERIOD_KEY = "evermind:spending:period";

const two = (n: number) => String(n).padStart(2, "0");

/** YYYY-MM-DD: the day it is on the device at that moment. */
export function localDate(d: Date): string {
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

/** A day of the device's calendar, at noon: a zone whose clocks change at midnight has no midnight
 *  that day. Months and days past their end roll over, as Date does. */
const dayAt = (today: Date, months: number, date: number) =>
  new Date(today.getFullYear(), today.getMonth() + months, date, 12);

/** The days a period covers, today its last; "all" has no first day. */
export function rangeOf(per: Period, today: Date): { from?: string; to: string } {
  const to = localDate(today);
  switch (per) {
    case "7": return { from: localDate(dayAt(today, 0, today.getDate() - 6)), to };
    case "30": return { from: localDate(dayAt(today, 0, today.getDate() - 29)), to };
    case "month": return { from: localDate(dayAt(today, 0, 1)), to };
    // Day 0 of this month is the last of the one before.
    case "last": return { from: localDate(dayAt(today, -1, 1)), to: localDate(dayAt(today, 0, 0)) };
    case "all": return { to };
  }
}

/** How many days a range covers, both ends counted. Read on UTC's calendar, which has no day of 23
 *  or 25 hours. */
export function daysOf(range: { from: string; to: string }): number {
  const utc = (day: string) => Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)));
  return Math.round((utc(range.to) - utc(range.from)) / 86_400_000) + 1;
}

/** The period chosen last on this device; 30 days the first time, or when what it kept is not one. */
export function keptPeriod(): Period {
  try {
    const kept = data.device.get(PERIOD_KEY);
    if (kept !== null && PERIODS.includes(kept)) return kept as Period;
  } catch {
    /* a store that cannot be read has kept nothing */
  }
  return "30";
}

export function keepPeriod(per: Period): void {
  try {
    data.device.set(PERIOD_KEY, per);
  } catch {
    /* the choice lasts as long as the page */
  }
}

/** What a line or a total holds: money, and the calls that read something with no price for it. */
export interface Money { cost: number; unpriced: number; currency: string }

const formats = new Map<string, Intl.NumberFormat>();

function format(locale: string, currency: string, decimals: number): Intl.NumberFormat {
  const key = `${locale}\u0000${currency}\u0000${decimals}`;
  let made = formats.get(key);
  if (!made) {
    // The sign alone, "$", as every price of the interface writes it (lib/money.ts).
    made = new Intl.NumberFormat(locale, {
      style: "currency", currency, currencyDisplay: "narrowSymbol",
      minimumFractionDigits: decimals, maximumFractionDigits: decimals,
    });
    formats.set(key, made);
  }
  return made;
}

/** An amount spent: to the cent, and "less than 0.01" for what would round to nothing, which is
 *  not nothing. Nothing at all has no cents to show. */
export function amountText(cost: number, currency: string, locale: string, t: T): string {
  if (!(cost > 0)) return format(locale, currency, 0).format(0);
  if (Math.round(cost * 100) === 0) return t("spending.money.under", { money: format(locale, currency, 2).format(0.01) });
  return format(locale, currency, 2).format(cost);
}

/** The amount of a line or a total, with the calls it could not price; never zero for calls that
 *  read something with no price, which may have cost money. A line with neither says "nothing". */
export function moneyText(m: Money, where: "total" | "line", locale: string, t: T): string {
  if (m.cost > 0 && m.unpriced > 0) {
    return t("spending.money.withUnpriced", { money: amountText(m.cost, m.currency, locale, t), count: m.unpriced });
  }
  if (m.unpriced > 0) return t("ai.priceNone");
  if (m.cost > 0) return amountText(m.cost, m.currency, locale, t);
  return where === "total" ? amountText(0, m.currency, locale, t) : t("spending.money.nothing");
}

const months = new Map<string, Intl.DateTimeFormat>();

function monthName(d: Date, locale: string, today: Date): string {
  const withYear = d.getFullYear() !== today.getFullYear();
  const key = `${locale}\u0000${withYear}`;
  let made = months.get(key);
  if (!made) {
    made = new Intl.DateTimeFormat(locale, { month: "long", ...(withYear ? { year: "numeric" } : {}) });
    months.set(key, made);
  }
  return made.format(d);
}

/** The period in words, for a sentence: "in the last 7 days", "in November", "since October 6". */
export function duringText(per: Period, since: string, locale: string, t: T, today: Date = new Date()): string {
  switch (per) {
    case "7": return t("spending.during.7");
    case "30": return t("spending.during.30");
    case "month": return t("spending.during.month", { month: monthName(dayAt(today, 0, 1), locale, today) });
    case "last": return t("spending.during.month", { month: monthName(dayAt(today, -1, 1), locale, today) });
    case "all": return t("spending.during.all", { date: dayMonth(since, locale, today) });
  }
}

/** What a hundred replies of an AI cost, measured from its last ones. */
export function measuredText(measured: { cost: number; n: number; typed: boolean }, locale: string, t: T): string {
  const said = t("money.measured", { amount: per100(measured.cost, locale), count: measured.n });
  return measured.typed ? said + t("money.measuredTyped") : said;
}

/** The one guard of every line, route and dialog of Spending: an edition without it draws none. */
export function spendingShown(source: Pick<DataSource, "spending">): boolean {
  return source.spending !== undefined;
}

/** A sum of amounts, to the millionth as the server writes them: 1.43 + 0.01 is 1.44. */
const summed = (a: number, b: number) => Math.round((a + b) * 1e6) / 1e6;

/** The AIs of a period under the service they ran on. */
export interface ServiceGroup {
  name: string | null;
  /** What it billed, through a key of one's own included. */
  cost: number;
  unpriced: number;
  /** Those with an amount first, then those with no price, each in the server's order. */
  lines: Spending["models"];
  /** What the original services billed through a key of one's own, by service. */
  upstream: { name: string; cost: number }[];
}

/** The AIs grouped by service, the dearest service first. */
export function servicesOf(models: Spending["models"]): ServiceGroup[] {
  const groups = new Map<string | null, ServiceGroup>();
  for (const line of models) {
    const [, , service, cost, upstreamCost, upstream, , , , , unpriced] = line;
    let group = groups.get(service);
    if (!group) groups.set(service, (group = { name: service, cost: 0, unpriced: 0, lines: [], upstream: [] }));
    group.cost = summed(group.cost, summed(cost, upstreamCost));
    group.unpriced += unpriced;
    group.lines.push(line);
    if (upstream !== null && upstreamCost > 0) {
      const by = group.upstream.find((u) => u.name === upstream);
      if (by) by.cost = summed(by.cost, upstreamCost);
      else group.upstream.push({ name: upstream, cost: upstreamCost });
    }
  }
  const priced = (line: Spending["models"][number]) => line[3] + line[4] > 0;
  return [...groups.values()]
    .map((group) => ({ ...group, lines: [...group.lines.filter(priced), ...group.lines.filter((l) => !priced(l))] }))
    // Stable: services of the same amount keep the order the server gave their AIs.
    .sort((a, b) => b.cost - a.cost);
}

/** Pages read by a free AI: a page is about 500 tokens. */
export function pagesOf(tokens: number): number {
  return Math.round(tokens / 500);
}
