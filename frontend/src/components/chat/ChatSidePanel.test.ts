import { I18nProvider } from "@/i18n/I18nProvider";
import type { Character, Conversation } from "@/types";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { expect, test } from "vitest";
import { ChatSidePanel } from "./ChatSidePanel";

const character = { id: "c1", kind: "character", name: "Vane", scenario: "", card_rules: 2 } as unknown as Character;

function opened(fields: Partial<Conversation>) {
  const conversation = {
    id: "v1", character_id: "c1", persona_id: null, connection_id: null, title: "", summary: "",
    character, ...fields,
  } as Conversation;
  return renderToString(createElement(MemoryRouter, null, createElement(I18nProvider, {
    initialLocale: "en",
    children: createElement(ChatSidePanel, {
      conversation, persona: null, onClose: () => {}, onConversationChange: () => {}, onAdjustWallpaper: () => {},
    }),
  })));
}

/** The button of the panel whose words are these, as drawn. */
const button = (html: string, words: string) => {
  const found = [...html.matchAll(/<button[^>]*>(?:(?!<\/button>).)*<\/button>/gs)].map((m) => m[0])
    .find((b) => b.replace(/<[^>]+>/g, "").includes(words));
  if (!found) throw new Error(`no button ${words}`);
  return { disabled: /\sdisabled=""/.test(found), spinning: found.includes("animate-spin") };
};

test("a condensing found running on opening is shown as if asked from here: both buttons wait", () => {
  const html = opened({ memory_running: true, memory_operation: "consolidate" });
  expect(button(html, "Condense")).toEqual({ disabled: true, spinning: true });
  expect(button(html, "Remember")).toEqual({ disabled: true, spinning: false });
});

test("a Remember found running on opening, or the automatic pass, turns on Remember", () => {
  for (const memory_operation of ["extract", "pass"] as const) {
    const html = opened({ memory_running: true, memory_operation });
    expect(button(html, "Remember")).toEqual({ disabled: true, spinning: true });
    expect(button(html, "Condense")).toEqual({ disabled: true, spinning: false });
  }
});

test("nothing running, nothing waits", () => {
  const html = opened({ memory_running: false, memory_operation: null });
  expect(button(html, "Remember")).toEqual({ disabled: false, spinning: false });
  expect(button(html, "Condense")).toEqual({ disabled: false, spinning: false });
});

test("a failure found on opening is told, with a way to try again", () => {
  const html = opened({ memory_error: { error: "http://localhost:1234/v1", kind: "unreachable" } });
  expect(html).toContain("Evermind cannot reach the model&#x27;s server at http://localhost:1234/v1.");
  expect(button(html, "Try again")).toEqual({ disabled: false, spinning: false });
});
