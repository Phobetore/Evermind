import { I18nProvider } from "@/i18n/I18nProvider";
import { BUILT_IN } from "@/engine";
import type { Outlook, OutlookEntry, Way } from "@/types";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { ReadingBlock } from "./ReadingBlock";

const balanced: Way = { id: "balanced", name: null, built_in: true, overridden: false, ...BUILT_IN.balanced };

function entry(over: Partial<OutlookEntry> = {}): Outlook["current"] {
  return {
    model_id: "m1", play_style: "balanced", used_tokens: 9_000, budget: 29_778, context_size: 32_768,
    messages_included: 24, messages_total: 200, history_limit: 24, reply_room: 1_024,
    parts: { card: 1_700, reminders: 600, history: 6_700 }, cap_short: null,
    ...over, way: { ...balanced, adjusted: false },
  };
}

/** The block as the sheet draws it whole, its tags taken away. */
function shown(current: Outlook["current"], name: string | null = "Aube") {
  const outlook: Outlook = { current, models: [], ways: [] };
  return renderToStaticMarkup(createElement(I18nProvider, {
    initialLocale: "en",
    children: createElement(ReadingBlock, { entry: current, name, outlook, compact: false, part: "whole" }),
  })).replace(/<[^>]+>/g, "\n");
}

/** The width the bar gives the room kept for the reply, its last part. */
function roomWidth(current: Outlook["current"]) {
  const outlook: Outlook = { current, models: [], ways: [] };
  const html = renderToStaticMarkup(createElement(I18nProvider, {
    initialLocale: "en",
    children: createElement(ReadingBlock, { entry: current, name: "Aube", outlook, compact: false, part: "whole" }),
  }));
  return [...html.matchAll(/<i [^>]*width:([\d.]+)%/g)].map((m) => Number(m[1])).at(-1);
}

describe("the room kept for the reply", () => {
  test("is what the turn keeps when the server says it", () => {
    // An AI that reasons: the way's room of 1,024, and 4,096 kept with its thinking.
    const reasons = entry({ reply_room: 1_024, reply_kept: 4_096 });
    expect(shown(reasons)).toContain("room for the reply 4,096");
    expect(roomWidth(reasons)).toBeCloseTo((4_096 / 32_768) * 100, 1);
    // Light with an AI sent no ceiling: 1,024 kept for a room of 512.
    expect(shown(entry({ reply_room: 512, reply_kept: 1_024 }))).toContain("room for the reply 1,024");
    // An AI fixed at 300: 300 kept for a room of 1,024.
    const fixed = entry({ reply_room: 1_024, reply_kept: 300 });
    expect(shown(fixed)).toContain("room for the reply 300 ");
    expect(roomWidth(fixed)).toBeCloseTo((300 / 32_768) * 100, 1);
  });

  test("is the way's room from a server that does not say what it keeps", () => {
    const old = entry({ reply_room: 1_024 });
    expect(shown(old)).toContain("room for the reply 1,024");
    expect(roomWidth(old)).toBeCloseTo((1_024 / 32_768) * 100, 1);
  });
});
