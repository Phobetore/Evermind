import type { Page, Route } from "@playwright/test";
import type {
  Spending, SpendingDetailOfCard, SpendingDetailOfConversation, SpendingDetailOfModel, SpendingDetailOfUse,
} from "../src/types";

/**
 * Answers of the server, made by hand, for the page of Spending: the shapes of
 * backend/app/repositories/calls.py, filled as a person's month and year of play would fill them.
 * Days are the machine's own, counted back from today, as the page counts them.
 */

const two = (n: number) => String(n).padStart(2, "0");

/** A day of the machine's calendar `back` days before today, as the page writes one. */
export function dayBefore(back: number, today = new Date()): string {
  const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - back, 12);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

/** An instant of that day, at noon UTC. */
const instant = (day: string) => `${day}T12:00:00.000+00:00`;

/** "November 20", as the page writes a day of this year in English. */
export function inWords(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Intl.DateTimeFormat("en", { day: "numeric", month: "long" }).format(new Date(y, m - 1, d, 12));
}

const NO_SOURCES = { reported: 0, computed_read: 0, computed_typed: 0, estimated: 0 };

/** A period with no call at all, counting since today. */
export function nothing(): Spending {
  return {
    since: instant(dayBefore(0)), currency: "USD", total: 0, model_total: null, previous: { cost: 0, unpriced_calls: 0 }, calls: 0,
    sources: NO_SOURCES, outside_replies: { cost: 0, calls: 0, unpriced_calls: 0, free_calls: 0 }, uses: [],
    series: { step: "day", points: Array.from({ length: 30 }, (_, i) => [dayBefore(29 - i), 0, 0]) },
    models: [], free: [], cards: [], cards_rest: null, conversations: [], conversations_rest: null,
    unpriced: { calls: 0, tokens_in: 0, tokens_out: 0 },
  };
}

/** Thirty days of play: AIs on OpenRouter (one through a key of one's own, billed by Anthropic),
 *  one so cheap it rounds to nothing, a gateway with no price, two free ones, characters, a
 *  scenario, a deleted character and conversation, the drafts of a card not saved yet. The lines
 *  only with free AIs come first, so that putting them last is the page's own doing. */
export function month(): Spending {
  return {
    since: instant(dayBefore(60)), currency: "USD", total: 3.0242, model_total: null, previous: { cost: 2.5, unpriced_calls: 0 }, calls: 395,
    sources: { reported: 1.44, computed_read: 0.0042, computed_typed: 0, estimated: 0.02 },
    outside_replies: { cost: 1.58, calls: 62, unpriced_calls: 0, free_calls: 0 },
    uses: [
      ["memory", 1.54, 40, 3, 21, 98000, 6000, 0],
      ["reply", 0.1, 300, 4, 184, 25456, 1890, 14],
      ["card", 0.04, 2, 0, 0, 0, 0, 0],
      ["speed", 0, 2, 0, 0, 0, 0, 2],
    ],
    series: {
      step: "day",
      points: Array.from({ length: 30 }, (_, i) => [dayBefore(29 - i), Math.round(i * 100) / 10_000 + 0.01, 0.005]),
    },
    models: [
      ["ai-sylve", "Sylve Mini", "OpenRouter", 1.43, 0, null, 120, 100, 500000, 40000, 0, false],
      ["ai-claude", "Claude Byok", "OpenRouter", 0, 0.01, "Anthropic", 3, 3, 9000, 800, 0, false],
      ["ai-aurore", "Aurore", "Lumen", 0.0042, 0, null, 2, 2, 3000, 200, 0, false],
      ["ai-gateway", "Gateway", "Home gateway", 0, 0, null, 205, 190, 123456, 7890, 205, false],
    ],
    free: [
      ["ai-brume", "Brume 12B", "pc", 14, 250000, "LM Studio"],
      ["ai-eclair", "Eclair Free", "service", 5, 4000, "OpenRouter"],
    ],
    cards: [
      ["card-home", "Home only", "character", 0, 14, 0, 0, 0, true, false],
      ["card-serana", "Serana", "character", 1.6, 300, 184, 98765, 4321, false, false],
      ["card-vigil", "The Elmswood Vigil", "scenario", 0.2, 10, 0, 0, 0, false, false],
      ["card-old", "Old friend", "character", 0.05, 3, 0, 0, 0, false, true],
      [null, null, null, 0.04, 2, 0, 0, 0, false, false],
    ],
    cards_rest: null,
    conversations: [
      ["conv-free", "Quiet evening", "Home only", 0, 14, 0, 0, 0, true, false],
      ["conv-inn", "At the inn", "Serana", 1.64, 230, 205, 123456, 7890, false, false],
      ["conv-gone", "Lost road", "Old friend", 0.05, 3, 0, 0, 0, false, true],
    ],
    conversations_rest: null,
    unpriced: { calls: 205, tokens_in: 123456, tokens_out: 7890 },
  };
}

/** A year of play since the start: a bar a week, fifty conversations and characters listed and
 *  the rest in one line each. */
export function year(): Spending {
  const base = month();
  const weeks = Array.from({ length: 53 }, (_, i) => [dayBefore((52 - i) * 7), 0.4 + (i % 7) / 10, 0.1] as
    [string, number, number]);
  const names = ["Serana", "Corvin", "Maelis", "Ondine", "Tarik"];
  return {
    ...base,
    since: instant(dayBefore(370)), previous: null, total: 42.5, calls: 55000,
    series: { step: "week", points: weeks },
    cards: Array.from({ length: 50 }, (_, i) =>
      [`card-${i}`, `${names[i % 5]} of the Long Name Hollow ${i}`, i % 9 ? "character" : "scenario", 2 - i / 50, 900 - i,
        0, 0, 0, false, i % 13 === 0] as Spending["cards"][number]),
    cards_rest: [12, 0.42, 300, 0],
    conversations: Array.from({ length: 50 }, (_, i) =>
      [`conv-${i}`, `A very long evening at the Elmswood inn, part ${i}`, names[i % 5], 1.5 - i / 50, 700 - i, i % 4,
        (i % 4) * 4000, (i % 4) * 300, false, i % 11 === 0] as Spending["conversations"][number]),
    conversations_rest: [250, 3.1, 4100, 12],
  };
}

const sylve: SpendingDetailOfModel = {
  name: "Sylve Mini", service_name: "OpenRouter", deleted: false, priceable: false,
  per100: { cost: 1.2, n: 100, typed: false }, cost: 1.43, cost_upstream: 0, upstream: null, calls: 120,
  unpriced_calls: 0, tokens: { in: 500000, out: 40000, cached: 20000, reasoning: 0 },
  sources: { reported: 1.43, computed_read: 0, computed_typed: 0, estimated: 0 }, at_most: false,
  uses: [["reply", 1.3, 100, 4, 0], ["memory", 0.13, 20, 0, 0]],
  cards: [["card-serana", "Serana", "character", 1.4, 110, false], ["card-old", "Old friend", "character", 0.03, 10, true]],
  cards_rest: null,
};

/** An AI whose computed amount read from the cache with no price for it. */
const aurore: SpendingDetailOfModel = {
  name: "Aurore", service_name: "Lumen", deleted: false, priceable: false, per100: null, cost: 0.12,
  cost_upstream: 0, upstream: null, calls: 2, unpriced_calls: 0, tokens: { in: 3000, out: 200, cached: 1000, reasoning: 0 },
  sources: { reported: 0, computed_read: 0.12, computed_typed: 0, estimated: 0 }, at_most: true,
  uses: [["reply", 0.12, 2, 0, 0]], cards: [["card-serana", "Serana", "character", 0.12, 2, false]], cards_rest: null,
};

/** An AI with no price: none of its calls has an amount, so no share of one is above zero. */
const gateway: SpendingDetailOfModel = {
  name: "Gateway", service_name: "Home gateway", deleted: false, priceable: true, per100: null, cost: 0,
  cost_upstream: 0, upstream: null, calls: 205, unpriced_calls: 205, tokens: { in: 123456, out: 7890, cached: 0, reasoning: 0 },
  sources: NO_SOURCES, at_most: false,
  uses: [["reply", 0, 190, 0, 190], ["memory", 0, 15, 0, 15]],
  cards: [["card-serana", "Serana", "character", 0, 184, false]], cards_rest: null,
};

const inn: SpendingDetailOfConversation = {
  title: "At the inn", card_name: "Serana", deleted: false, cost: 1.64, calls: 230, unpriced_calls: 205,
  models: [["ai-sylve", "Sylve Mini", 1.6, 20, 0, false], ["ai-gateway", "Gateway", 0, 205, 205, false],
    ["ai-brume", "Brume 12B", 0, 5, 0, true], ["ai-aurore", "Aurore", 0.0042, 2, 0, false]],
  uses: [["memory", 1.54, 40, 0, 21], ["reply", 0.1, 190, 4, 184]],
  growth: { first: 0.002, last: 0.011 },
};

const gone: SpendingDetailOfConversation = {
  title: "Lost road", card_name: "Old friend", deleted: true, cost: 0.05, calls: 3, unpriced_calls: 0,
  models: [["ai-sylve", "Sylve Mini", 0.05, 3, 0, false]], uses: [["reply", 0.05, 3, 0, 0]], growth: null,
};

const serana: SpendingDetailOfCard = {
  name: "Serana", kind: "character", deleted: false, cost: 1.6, calls: 300, unpriced_calls: 184,
  models: [["ai-sylve", "Sylve Mini", 1.6, 116, 0, false], ["ai-gateway", "Gateway", 0, 184, 184, false]],
  conversations: [["conv-inn", "At the inn", 1.6, 300, 184, false, false], ["conv-hearth", "By the hearth", 0, 9, 0, true, false]],
  conversations_rest: [88, 0.5, 120, 0],
};

/** A deleted character whose name is kept, with her deleted conversation. */
const old: SpendingDetailOfCard = {
  name: "Old friend", kind: "character", deleted: true, cost: 0.05, calls: 3, unpriced_calls: 0,
  models: [["ai-sylve", "Sylve Mini", 0.05, 3, 0, false]],
  conversations: [["conv-gone", "Lost road", 0.05, 3, 0, false, true]], conversations_rest: null,
};

const memory: SpendingDetailOfUse = {
  use: "memory", cost: 1.54, calls: 40, retried: 0, unpriced_calls: 21, unpriced_tokens_in: 98000,
  unpriced_tokens_out: 6000,
  models: [["ai-sylve", "Sylve Mini", 1.54, 19, 0, false], ["ai-gateway", "Gateway", 0, 21, 21, false]],
};

const DETAILS: Record<string, unknown> = {
  "model:ai-sylve": sylve,
  "model:ai-aurore": aurore,
  "model:ai-gateway": gateway,
  "conversation:conv-inn": inn,
  "conversation:conv-gone": gone,
  "card:card-serana": serana,
  "card:card-old": old,
  "use:memory": memory,
};

/** What the page asked of the server, by kind, in order. */
export interface Asked { summary: URL[]; detail: URL[]; forget: unknown[]; clear: URL[]; exported: URL[] }

/** Answers every question of the page about spending with `summary`, told what was asked (narrowed
 *  to one AI when it asks for one: Sylve Mini's $1.43; another listed AI is left whole, with nothing
 *  of its own as the server says of a free one; an AI the period does not list has no line), the
 *  details above (the Vigil's failing, any other missing), and a clear of 1,214 calls. */
export async function answerSpending(page: Page, summary: (url: URL) => Spending = month): Promise<Asked> {
  const asked: Asked = { summary: [], detail: [], forget: [], clear: [], exported: [] };
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  await page.route("**/api/spending**", async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (url.pathname.endsWith("/api/spending") && method === "GET") {
      asked.summary.push(url);
      const said = summary(url);
      const model = url.searchParams.get("model");
      if (!model) return json(route, said);
      const listed = [...said.models, ...said.free].some(([id]) => id === model);
      if (!listed) {
        return json(route, {
          ...said, model_total: 0, uses: [], cards: [], cards_rest: null, conversations: [], conversations_rest: null,
        });
      }
      if (model === "ai-sylve") {
        return json(route, {
          ...said, model_total: 1.43, uses: said.uses.slice(0, 2),
          conversations: said.conversations.filter((c) => c[0] === "conv-inn"),
          cards: said.cards.filter((c) => c[0] === "card-serana"),
        });
      }
      return json(route, { ...said, model_total: 0 });
    }
    if (url.pathname.endsWith("/api/spending/detail")) {
      asked.detail.push(url);
      const found = DETAILS[`${url.searchParams.get("cut")}:${url.searchParams.get("key")}`];
      // The Vigil's line cannot be read: the server fails it. Any line not above no longer exists.
      if (url.searchParams.get("key") === "card-vigil") return json(route, { detail: "Down." }, 500);
      return found ? json(route, found) : json(route, { detail: "Nothing of that line was found.", kind: "not_found" }, 404);
    }
    if (url.pathname.endsWith("/api/spending/forget")) {
      asked.forget.push(route.request().postDataJSON());
      return json(route, { forgotten: 3 });
    }
    if (url.pathname.endsWith("/api/spending") && method === "DELETE") {
      asked.clear.push(url);
      const year = new Date().getFullYear();
      if (url.searchParams.get("dry_run") === "1") {
        return json(route, { calls: 1214, first: `${year}-11-20T10:00:00.000+00:00`, last: `${year}-12-14T10:00:00.000+00:00` });
      }
      return json(route, { deleted: 1214, since: new Date().toISOString() });
    }
    if (url.pathname.endsWith("/api/spending/export.csv")) {
      asked.exported.push(url);
      return route.fulfill({
        status: 200, contentType: "text/csv; charset=utf-8", body: "id,started_at\r\n",
        headers: { "Content-Disposition": `attachment; filename="evermind-spending-${dayBefore(0)}.csv"` },
      });
    }
    return route.continue();
  });
  return asked;
}
