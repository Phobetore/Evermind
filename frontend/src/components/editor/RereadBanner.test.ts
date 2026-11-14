import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, expect, test, vi } from "vitest";
import { I18nProvider } from "@/i18n/I18nProvider";
import { oldReading, readCardJson, rereadPlan, type FoundCard } from "@/lib/cards";
import { pairEntries } from "@/lib/cards/pairing";
import { RereadBanner } from "./RereadBanner";

vi.mock("@/lib/cards/pairing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cards/pairing")>();
  return { ...actual, pairEntries: vi.fn(actual.pairEntries) };
});

afterEach(() => {
  vi.mocked(pairEntries).mockClear();
});

const CARD = {
  spec: "chara_card_v2", spec_version: "2.0",
  data: {
    name: "Mirela", description: "A lighthouse keeper.", first_mes: "The lamp is lit.",
    character_book: { entries: [
      { keys: ["lamp"], content: "The lamp burns whale oil." },
      { keys: [], content: "The fog never lifts.", constant: true },
    ] },
  },
};

test("a keystroke in the form pairs no entry: the banner lists what it lists without the pairing", () => {
  const found: FoundCard = { read: readCardJson(CARD, JSON.stringify(CARD), "json")!, old: oldReading(CARD)! };
  const before = oldReading(CARD)!;
  const banner = (name: string) => renderToString(createElement(I18nProvider, {
    initialLocale: "en",
    children: createElement(RereadBanner, {
      current: { ...before, name, lore_entries: before.lore_entries.map((entry) => ({ ...entry, origin: null })) },
      found, failure: null, hasCard: false, applied: false, label: (field) => field, onApply: () => {}, onRetry: () => {},
    }),
  }));
  // The form opened, then a name typed a letter at a time.
  for (const name of ["Mirela", "Mirela ", "Mirela T"]) {
    const html = banner(name);
    expect(html).toContain("1 lorebook entry");
    expect(html).toContain(name === "Mirela" ? "Will be added or brought up to date:" : "Will stay as you left it:");
  }
  expect(pairEntries).not.toHaveBeenCalled();
  // The click pairs them.
  rereadPlan({ ...before, lore_entries: before.lore_entries.map((entry) => ({ ...entry, origin: null })) }, found, "reread");
  expect(pairEntries).toHaveBeenCalledTimes(1);
});
