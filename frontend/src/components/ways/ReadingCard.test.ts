import { BUILT_IN } from "@/engine";
import { I18nProvider } from "@/i18n/I18nProvider";
import type { Ai, WayFields } from "@/types";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { ReadingCard } from "./ReadingCard";

/** An AI that tells what it reads at once (32,768), does not reason, its ceiling left to Evermind. */
function ai(over: Partial<Ai> = {}): Ai {
  return {
    id: "m1",
    service: {
      id: "s1", name: "Local", family: "openai-compatible", local: true, loopback: true,
      provider: "openai-compatible", base_url: "http://127.0.0.1:5000/v1", api_key_set: false, api_key_hint: null,
    },
    model: "aube",
    name: "Aube",
    is_default: true,
    context: { own: null, read: 32_768, read_kind: "served", used: 32_768, source: "read" },
    output_read: null,
    reasons: false,
    price: { read_in: null, read_out: null, own_in: null, own_out: null, varies: false },
    free: true,
    limits_read_at: null,
    reply_cap: { mode: "auto", tokens: null },
    temperature: null, top_p: null, frequency_penalty: null, presence_penalty: null,
    migrated: false,
    notices: [],
    margin: 1966,
    token_ratio: null,
    reply_tokens: { short: null, medium: null, long: null },
    thinking_allowance: 3072,
    thinking_measured: false,
    usage_seen: null,
    anthropic: false,
    conversation_count: 0,
    created_at: "2026-11-01T10:00:00Z",
    updated_at: "2026-11-01T10:00:00Z",
    ...over,
  } as Ai;
}

/** The card as Settings draws it, its tags taken away. */
function shown(way: WayFields, ais: Ai[], locale: "en" | "fr" = "en") {
  return renderToStaticMarkup(createElement(I18nProvider, {
    initialLocale: locale,
    children: createElement(ReadingCard, { way, light: BUILT_IN.light as WayFields, ais, hostWindow: null }),
  })).replace(/&#x27;/g, "'").replace(/<[^>]+>/g, "\n");
}

const maximum = BUILT_IN.maximum as WayFields;

describe("what is sent past what the AI reads at once", () => {
  // 900 read at once: the engine's floor of 512 sent, and 450 kept for the reply.
  const small = ai({ context: { own: 900, read: null, read_kind: null, used: 900, source: "own" }, margin: 200 });

  test("is said in place of a full capacity", () => {
    const said = shown(maximum, [small]);
    expect(said).toContain("What is sent (≈ 1 page) is more than this AI reads at once (≈ 2 pages): its card and reminders do not fit. Choose a lighter way, or an AI that reads more.");
    expect(said).not.toContain("Its reading capacity is full");
  });

  test("a capacity full where everything fits says it as before", () => {
    const said = shown(maximum, [ai()]);
    expect(said).toContain("Its reading capacity is full");
    expect(said).not.toContain("What is sent");
  });
});
