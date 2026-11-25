// What the tests of the conversation's two sheets draw them with: an AI, a conversation, its
// outlook, and the sheets drawn as the server would, the browser's few globals they read stood in.

import { BUILT_IN } from "@/engine";
import { I18nProvider } from "@/i18n/I18nProvider";
import type { Locale } from "@/i18n/config";
import type { Ai, Conversation, Outlook, OutlookEntry, Way } from "@/types";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { vi } from "vitest";

/** An AI that tells what it reads at once (32,768), priced 0.20 / 0.60, its ceiling left to Evermind. */
export function aiOf(over: Partial<Ai> = {}): Ai {
  return {
    id: "m1",
    service: {
      id: "s1", name: "OpenRouter", family: "openrouter", local: false, loopback: false,
      provider: "openai-compatible", base_url: "https://openrouter.ai/api/v1", api_key_set: true, api_key_hint: "4f2a",
    },
    model: "brume/12b",
    name: "Brume",
    is_default: true,
    context: { own: null, read: 32_768, read_kind: "served", used: 32_768, source: "read" },
    output_read: null,
    reasons: false,
    price: { read_in: 0.2, read_out: 0.6, own_in: null, own_out: null, varies: false },
    free: false,
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

export function conversationOf(over: Partial<Conversation> = {}): Conversation {
  return {
    id: "v1", character_id: "c1", persona_id: null, model_id: "m1", model_lost: null, title: "", summary: "",
    backdrop: null, backdrop_strength: null, play_style: "balanced", play_overrides: null,
    created_at: "2026-11-01T10:00:00Z", updated_at: "2026-11-01T10:00:00Z", ...over,
  } as Conversation;
}

export const wayOf = (id: string): Way => ({ id, name: null, built_in: true, overridden: false, ...BUILT_IN[id] });

function entryOf(over: Partial<OutlookEntry> = {}): OutlookEntry {
  return {
    model_id: "m1", play_style: "balanced", used_tokens: 3_000, budget: 29_778, context_size: 32_768,
    messages_included: 5, messages_total: 5, history_limit: 24, reply_room: 1_024,
    parts: { card: 1_700, reminders: 600, history: 700 }, cap_short: null, ...over,
  };
}

/** Balanced played by `ais`' first, every AI under it, the four ways built in. */
export function outlookOf(ais: Ai[]): Outlook {
  return {
    current: { ...entryOf(), way: { ...wayOf("balanced"), adjusted: false } },
    models: ais.map((ai) => entryOf({ model_id: ai.id })),
    ways: ["light", "balanced", "immersive", "maximum"].map((id) => ({ ...entryOf({ play_style: id }), way: wayOf(id) })),
  };
}

/** The sheet as drawn, in a router, in `locale`. A dialog's opener and the root's size are read
 *  as it opens: none, and 16px. */
export function drawn(element: ReactElement, locale: Locale = "en"): string {
  vi.stubGlobal("document", { activeElement: null, documentElement: {} });
  vi.stubGlobal("getComputedStyle", () => ({ fontSize: "16px" }));
  try {
    return renderToStaticMarkup(createElement(MemoryRouter, null, createElement(I18nProvider, { initialLocale: locale, children: element })));
  } finally {
    vi.unstubAllGlobals();
  }
}

/** The words of what was drawn, a line for each piece of text. */
export const words = (html: string) => html.replace(/&#x27;/g, "'").replace(/<[^>]+>/g, "\n").replace(/\n+/g, "\n");
