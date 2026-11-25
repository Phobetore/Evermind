import { BUILT_IN } from "@/engine";
import { I18nProvider } from "@/i18n/I18nProvider";
import type { Outlook, Way } from "@/types";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { WayChip } from "./WayChip";

const immersive: Way = { id: "immersive", name: null, built_in: true, overridden: false, ...BUILT_IN.immersive };

/** Immersive, which asks for 60 messages, of which the AI rereads 33. */
const full: Outlook["current"] = {
  model_id: "m1", play_style: "immersive", used_tokens: 9_000, budget: 9_000, context_size: 16_384,
  messages_included: 33, messages_total: 200, history_limit: 60, reply_room: 2_048,
  parts: { card: 1_700, reminders: 600, history: 6_700 }, cap_short: null, way: { ...immersive, adjusted: false },
};

type Props = Parameters<typeof WayChip>[0];

/** The chip's words and its label read aloud. */
function chip(props: Partial<Props>) {
  const html = renderToStaticMarkup(createElement(I18nProvider, {
    initialLocale: "en",
    children: createElement(WayChip, { current: null, playStyle: "balanced", onOpen: () => {}, ...props }),
  }));
  return {
    text: html.replace(/<[^>]+>/g, "").trim(),
    aria: /aria-label="([^"]*)"/.exec(html)![1].replace(/&#x27;/g, "'"),
  };
}

describe("an AI whose reading capacity nobody told", () => {
  test("the chip read aloud says what it rereads, with no word of a capacity", () => {
    expect(chip({ current: full, capacityTold: false }).aria).toBe("Way to play: Immersive. It rereads 33 messages of 60. Change.");
    expect(chip({ current: full, capacityTold: false }).text).toBe("Immersive · rereads 33 of 60");
  });

  test("not given, the capacity is taken as told, as before", () => {
    expect(chip({ current: full }).aria).toBe("Way to play: Immersive. Its reading capacity is full: it rereads 33 messages of 60. Change.");
  });
});

describe("before the first outlook", () => {
  test("the chip says adjusted from the conversation's own adjustments", () => {
    expect(chip({ playStyle: "balanced", playOverrides: { reply_length: "long" } })).toEqual({
      text: "Balanced · adjusted", aria: "Way to play: Balanced · adjusted. Change.",
    });
  });

  test("with none, or none given, the way's name alone, as before", () => {
    expect(chip({ playStyle: "balanced", playOverrides: null }).text).toBe("Balanced");
    expect(chip({ playStyle: "balanced", playOverrides: {} }).text).toBe("Balanced");
    expect(chip({ playStyle: "balanced" }).text).toBe("Balanced");
  });

  test("once the outlook has come, it says what the outlook says", () => {
    expect(chip({ current: full, playOverrides: { reply_length: "long" } }).text).toBe("Immersive · rereads 33 of 60");
  });
});
