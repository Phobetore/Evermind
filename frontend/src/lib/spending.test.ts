import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { translate } from "@/i18n/translate";
import {
  amountText, daysOf, duringText, keepPeriod, keptPeriod, localDate, measuredText, moneyText, rangeOf,
  spendingShown, zoneOfDevice,
} from "./spending";
import { dayMonth } from "./utils";

// Every day here is a day in Paris, set before anything reads a date: the clocks go back there on
// 25 October 2026, and a call at 23:30 is the next day in UTC.
const zoneBefore = vi.hoisted(() => {
  const before = process.env.TZ;
  process.env.TZ = "Europe/Paris";
  return before;
});

const kept = new Map<string, string>();
let broken = false;
vi.mock("@/data", () => ({
  data: {
    device: {
      get: (key: string) => {
        if (broken) throw new Error("storage is not allowed");
        return kept.get(key) ?? null;
      },
      set: (key: string, value: string) => {
        if (broken) throw new Error("storage is not allowed");
        kept.set(key, value);
      },
    },
  },
}));

const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const fr = (key: string, vars?: Record<string, string | number>) => translate("fr", key, vars);
// Intl's own space between the figure and the sign.
const NBSP = " ";

/** An afternoon of that day in Paris. */
const day = (year: number, month: number, date: number) => new Date(year, month - 1, date, 15);

afterAll(() => {
  if (zoneBefore === undefined) delete process.env.TZ;
  else process.env.TZ = zoneBefore;
});

describe("periods across a month end, a year end and the clock change", () => {
  test("a period is a range of the device's days, today included", () => {
    expect(rangeOf("month", day(2027, 1, 1))).toEqual({ from: "2027-01-01", to: "2027-01-01" });
    expect(rangeOf("last", day(2027, 1, 1))).toEqual({ from: "2026-12-01", to: "2026-12-31" });
    expect(rangeOf("7", day(2027, 1, 1))).toEqual({ from: "2026-12-26", to: "2027-01-01" });
    expect(rangeOf("month", day(2026, 3, 31))).toEqual({ from: "2026-03-01", to: "2026-03-31" });
    expect(rangeOf("last", day(2026, 3, 31))).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(rangeOf("30", day(2026, 3, 31))).toEqual({ from: "2026-03-02", to: "2026-03-31" });
    expect(rangeOf("7", day(2026, 10, 26))).toEqual({ from: "2026-10-20", to: "2026-10-26" });
    expect(rangeOf("all", day(2026, 10, 26))).toEqual({ to: "2026-10-26" });
  });

  test("a period counts its days, the one the clocks go back included once", () => {
    expect(daysOf(rangeOf("month", day(2027, 1, 1)) as { from: string; to: string })).toBe(1);
    expect(daysOf(rangeOf("month", day(2026, 3, 31)) as { from: string; to: string })).toBe(31);
    expect(daysOf(rangeOf("7", day(2026, 10, 26)) as { from: string; to: string })).toBe(7);
    expect(daysOf(rangeOf("30", day(2026, 11, 10)) as { from: string; to: string })).toBe(30);
    expect(daysOf(rangeOf("last", day(2026, 11, 10)) as { from: string; to: string })).toBe(31);
  });

  test("a moment is the day it is on the device, and the device says its zone", () => {
    expect(localDate(new Date("2026-11-24T23:30:00Z"))).toBe("2026-11-25");
    expect(localDate(new Date("2026-11-24T22:30:00Z"))).toBe("2026-11-24");
    vi.useFakeTimers({ now: new Date("2026-07-01T12:00:00Z") });
    try {
      expect(zoneOfDevice()).toEqual({ tz: "Europe/Paris", tzo: 120 });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the row rule", () => {
  const money = (cost: number, unpriced: number) => ({ cost, unpriced, currency: "USD" });

  test("an amount, the calls it could not price, or neither", () => {
    expect(moneyText(money(0.1, 184), "line", "en", en)).toBe("$0.10 + 184 calls without a price");
    expect(moneyText(money(0, 184), "line", "en", en)).toBe("price not given");
    expect(moneyText(money(0.004, 0), "line", "en", en)).toBe("less than $0.01");
    expect(moneyText(money(0, 0), "total", "en", en)).toBe("$0");
    expect(moneyText(money(0, 0), "line", "en", en)).toBe("nothing");
    expect(moneyText(money(0.1, 1), "line", "en", en)).toBe("$0.10 + 1 call without a price");
    expect(moneyText(money(0.1, 184), "line", "fr", fr)).toBe(`0,10${NBSP}$ + 184 appels sans prix`);
  });

  test("an amount has two decimals, and the sign alone in each language", () => {
    expect(amountText(18.424, "USD", "en", en)).toBe("$18.42");
    expect(amountText(18.424, "USD", "fr", fr)).toBe(`18,42${NBSP}$`);
    expect(amountText(18.424, "USD", "es", en)).toBe(`18,42${NBSP}$`);
    expect(amountText(1234.5, "USD", "en", en)).toBe("$1,234.50");
    expect(amountText(0.005, "USD", "en", en)).toBe("$0.01");
    expect(amountText(0, "USD", "en", en)).toBe("$0");
  });
});

describe("the period said in words", () => {
  const since = "2026-10-06T07:00:00.000+00:00";

  test("the days, the month, or since when", () => {
    expect(duringText("all", since, "en", en, day(2026, 11, 25))).toBe("since October 6");
    expect(duringText("all", since, "fr", fr, day(2026, 11, 25))).toBe("depuis le 6 octobre");
    expect(duringText("last", since, "en", en, day(2027, 1, 3))).toBe("in December 2026");
    expect(duringText("month", since, "en", en, day(2026, 11, 25))).toBe("in November");
    expect(duringText("last", since, "fr", fr, day(2026, 11, 25))).toBe("en octobre");
    expect(duringText("7", since, "en", en, day(2026, 11, 25))).toBe("in the last 7 days");
    expect(duringText("30", since, "fr", fr, day(2026, 11, 25))).toBe("ces 30 derniers jours");
    expect(duringText("all", since, "en", en, day(2027, 2, 1))).toBe("since October 6, 2026");
  });

  test("a day is the device's, and a bare date is that day wherever the device is", () => {
    expect(dayMonth("2026-11-24T23:30:00.000+00:00", "en", day(2026, 11, 25))).toBe("November 25");
    expect(dayMonth("2026-11-24", "fr", day(2026, 11, 25))).toBe("24 novembre");
    expect(dayMonth("2025-11-24", "de", day(2026, 11, 25))).toBe("24. November 2025");
    expect(dayMonth("not a day", "en")).toBe("");
  });
});

describe("the tokens of a line", () => {
  test("one token is said in the singular, in each language", () => {
    const one = (locale: "fr" | "en" | "de" | "es") =>
      ["in", "out", "cached", "reasoning"].map((k) => translate(locale, `spending.detail.${k}`, { count: 1 }));
    expect(one("fr")).toEqual([
      "Lu : 1 token", "Écrit : 1 token", "dont 1 relu depuis le cache", "dont 1 de réflexion",
    ]);
    // French says zero in the singular too.
    expect(translate("fr", "spending.detail.out", { count: 0 })).toBe("Écrit : 0 token");
    expect(one("en")).toEqual([
      "Read: 1 token", "Written: 1 token", "of which 1 read from the cache", "of which 1 thinking",
    ]);
    expect(one("de")).toEqual([
      "Gelesen: 1 Token", "Geschrieben: 1 Token", "davon 1 aus dem Cache gelesen", "davon 1 zum Nachdenken",
    ]);
    expect(one("es")).toEqual([
      "Leído: 1 token", "Escrito: 1 token", "de los cuales 1 leído de la caché", "de los cuales 1 de razonamiento",
    ]);
    expect(translate("en", "spending.detail.in", { count: 12345 })).toBe("Read: 12,345 tokens");
  });

  test("a count of calls is grouped as the language groups it", () => {
    const counts = ["spending.calls", "spending.retried", "spending.freeCalls", "spending.free.replies",
      "spending.rest", "spending.cleared"];
    for (const key of counts) expect(translate("en", key, { count: 1214 })).toContain("1,214");
    expect(translate("en", "spending.money.withUnpriced", { money: "$1.00", count: 1214 }))
      .toBe("$1.00 + 1,214 calls without a price");
    expect(translate("en", "spending.clear.count", { count: 1214, first: "November 20", last: "December 14" }))
      .toMatch(/^1,214 calls, from November 20 to December 14\./);
    expect(translate("de", "spending.calls", { count: 1214 })).toContain("1.214");
  });
});

describe("the measured figure", () => {
  test("what a hundred replies cost, from how many, and whose price", () => {
    expect(measuredText({ cost: 4.9, n: 100, typed: false }, "en", en))
      .toBe("$4.90 per 100 messages, from your last 100 replies");
    expect(measuredText({ cost: 4.9, n: 100, typed: true }, "en", en))
      .toBe("$4.90 per 100 messages, from your last 100 replies, with your price");
    expect(measuredText({ cost: 0.0123, n: 34, typed: false }, "fr", fr))
      .toBe(`0,012${NBSP}$ les 100 messages, d'après vos 34 dernières réponses`);
  });
});

describe("the period kept on this device", () => {
  beforeEach(() => {
    kept.clear();
    broken = false;
  });
  afterEach(() => {
    broken = false;
  });

  test("the one chosen comes back, and anything else is 30 days", () => {
    expect(keptPeriod()).toBe("30");
    keepPeriod("month");
    expect(keptPeriod()).toBe("month");
    expect(kept.get("evermind:spending:period")).toBe("month");
    kept.set("evermind:spending:period", "fortnight");
    expect(keptPeriod()).toBe("30");
  });

  test("a store that cannot keep anything keeps nothing, and breaks nothing", () => {
    broken = true;
    expect(() => keepPeriod("7")).not.toThrow();
    expect(keptPeriod()).toBe("30");
  });
});

describe("the one guard", () => {
  test("Spending is shown only by a source that has it", () => {
    expect(spendingShown({})).toBe(false);
    expect(spendingShown({ spending: {} as never })).toBe(true);
  });
});
