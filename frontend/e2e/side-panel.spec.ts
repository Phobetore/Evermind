import { expect, test, type APIRequestContext, type Locator, type Page, type Route } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { API } from "../playwright.config";
import { makeCharacter, PNG } from "./fixtures";

/**
 * The panel beside a conversation is a fixed 320px column (the whole screen on
 * a phone), and what goes in it is longer in some languages than in others. The
 * button row under "Established facts" was a few pixels wider than that column
 * in English: the second button ran past the edge, was clipped by the screen,
 * and the panel could be dragged sideways to find it. Nothing in the typechecker
 * or the build knows about that, and it only showed in the languages whose words
 * are long enough, so every language is looked at, with the panel as full as it
 * gets.
 */

const LOCALES = ["en", "fr", "de", "es"] as const;
type Locale = (typeof LOCALES)[number];

/** The real strings, so the test asks for the buttons by what they say in that
 *  language, and so a page that quietly stayed in English cannot pass. */
function messages(locale: Locale) {
  const file = path.join(import.meta.dirname, "..", "src", "i18n", "locales", `${locale}.json`);
  const chat = JSON.parse(readFileSync(file, "utf8")).chat;
  return { ...chat.panel, wallpaper: chat.wallpaper } as {
    facts: { consolidateButton: string; extractButton: string };
    summary: { saveButton: string; placeholder: string };
    directive: { applyButton: string; placeholder: string };
    wallpaper: { replace: string };
  };
}

/** Words for a fact of a given length, different for each `seed` because an
 *  exact repeat of a fact is refused. */
function sentence(seed: string, length: number) {
  let text = "";
  for (let i = 0; text.length < length; i++) text += `${seed} remembers the harbour, number ${i}. `;
  return text.slice(0, length).trim();
}

const FACTS = [
  "Mira keeps the lighthouse key under the third stone.",
  "The ferry runs on Tuesdays only.",
  "Her brother left for the capital in the spring.",
  "The mill burned down the winter before last.",
  "Nobody speaks of the well behind the chapel.",
  "The innkeeper owes the harbour master a favour.",
  "There is a cat, and it answers to Biscuit.",
  "The bridge was repaired with stone from the old wall.",
  "She does not take sugar.",
  // A pasted link has no spaces to break at.
  "Source: https://example.org/wiki/The_Long_Winter_of_the_Third_Age_and_Everything_That_Came_After_It",
  // Long facts, to fill the panel the way a long story does.
  sentence("Anselm", 1900),
  sentence("Brigid", 1900),
  sentence("Corvin", 1900),
  sentence("Dagny", 1900),
];

/** A conversation with everything in the panel switched on: long names, a
 *  two-digit number of facts, a summary, a directive, a backdrop. The panel
 *  only draws some of its controls when there is something for them to act on.
 *  The names are one long word each, the way a handle is: a long name with
 *  spaces in it breaks at them and proves nothing. */
async function busyConversation(request: APIRequestContext) {
  const persona = await (await request.post(`${API}/api/personas`, {
    data: { name: "Xx_NightWalkerOfTheSilentHollowCrypt_xX", description: "A long name." },
  })).json();
  const character = await makeCharacter(request, {
    name: "xX_DarkLordSephirothOfTheNinthFlame_1999_Xx",
    scenario: "A fog-bound harbour town, the night before the ferry stops running for the winter."
      + " Timetable: harbourtown_ferry_timetable_winter_2026_fogbound_edition_final_v2",
  });
  const convo = await (await request.post(`${API}/api/conversations`, {
    data: { character_id: character.id, persona_id: persona.id },
  })).json();

  await request.patch(`${API}/api/conversations/${convo.id}`, {
    data: {
      summary: "They met at the harbour and agreed to meet again before the ferry stops.",
      author_note: "Keep it slow. Fog, lamplight, nothing resolved tonight.",
    },
  });
  await request.post(`${API}/api/conversations/${convo.id}/wallpaper`, {
    multipart: { file: { name: "backdrop.png", mimeType: "image/png", buffer: PNG } },
  });
  for (const content of FACTS) {
    const saved = await request.post(`${API}/api/conversations/${convo.id}/memories`, {
      data: { content },
    });
    expect(saved.ok(), `could not add a fact: ${content.slice(0, 30)}`).toBe(true);
  }
  return convo.id as string;
}

/** Open the conversation in a language, with the panel showing, and with both
 *  of the buttons that only appear once a text has been changed on screen. */
async function panelFor(page: Page, request: APIRequestContext, locale: Locale) {
  const text = messages(locale);
  const id = await busyConversation(request);
  // Where the app itself looks first.
  await page.addInitScript((chosen) => localStorage.setItem("evermind:locale", chosen), locale);
  await page.goto(`/#/chat/${id}`);
  await expect(page.locator("html")).toHaveAttribute("lang", locale);

  // On a laptop the panel is already open beside the conversation; on a phone,
  // and on a window narrower than a tablet, it is behind this button.
  await expect(page.locator("textarea").first()).toBeVisible();
  const opener = page.locator("header button:has(svg.lucide-sliders-horizontal)");
  if (await opener.isVisible()) await opener.click();

  // The panel is the one aside with text boxes in it; the other is navigation.
  const panel = page.locator("aside:visible:has(textarea)");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText(`(${FACTS.length})`);

  // Summary first: leaving the directive's box saves it, which would put the
  // button this is after away again.
  await panel.getByPlaceholder(text.summary.placeholder).fill("A summary that has been edited and not yet saved.");
  await panel.getByPlaceholder(text.directive.placeholder).fill("A directive that has been edited and not yet applied.");
  for (const label of [
    text.summary.saveButton,
    text.directive.applyButton,
    text.facts.consolidateButton,
    text.facts.extractButton,
  ]) {
    await expect(panel.getByRole("button", { name: label, exact: true }), `no "${label}" button in ${locale}`).toBeVisible();
  }
  return panel;
}

/** What is wider than the panel, by what it is. */
function measure(panel: Locator) {
  return panel.evaluate((aside) => {
    const describe = (el: Element) =>
      `${el.tagName.toLowerCase()} "${(el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 28)}"`;
    const box = aside.getBoundingClientRect();
    const style = getComputedStyle(aside);
    // Inside the border and the padding, and short of a scrollbar if there is
    // one. The padding is part of the panel, but it is what keeps the controls
    // off its edge: a button hanging 7px into it is lined up with nothing.
    const left = box.left + aside.clientLeft + parseFloat(style.paddingLeft);
    const right = box.left + aside.clientLeft + aside.clientWidth - parseFloat(style.paddingRight);
    const past = (el: Element) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return null; // not drawn
      return r.left < left - 0.5 || r.right > right + 0.5
        ? `${describe(el)} spans ${Math.round(r.left)}..${Math.round(r.right)}`
        : null;
    };
    const all = [...aside.querySelectorAll("*")];
    // The area added around a small control on a touch screen is meant to stick
    // out of it (and the panel's padding takes it up), so it is left out of the
    // question of which text runs out of its box. Everything else is measured
    // with it in.
    const hideReach = document.createElement("style");
    hideReach.textContent = ".touch-target::after { display: none !important }";
    document.head.append(hideReach);
    const spilling = all
      .filter((el) => !["TEXTAREA", "INPUT", "SELECT", "SVG", "OPTION"].includes(el.tagName.toUpperCase()))
      .filter((el) => el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1)
      .map((el) => `${describe(el)} is ${el.clientWidth}px wide and holds ${el.scrollWidth}px`);
    hideReach.remove();
    return {
      scrollWidth: aside.scrollWidth,
      clientWidth: aside.clientWidth,
      panel: `${Math.round(left)}..${Math.round(right)}`,
      buttons: aside.querySelectorAll("button").length,
      buttonsOutside: all.filter((el) => el.tagName === "BUTTON").map(past).filter(Boolean),
      othersOutside: all.filter((el) => el.tagName !== "BUTTON").map(past).filter(Boolean),
      // A box that stays where it should while its text runs out of it: a long
      // word with no place to break. Text boxes scroll their own text.
      spilling,
      // The .btn rule gives a phone 44px to hit; a row that wraps must not lose it.
      small: [...aside.querySelectorAll<HTMLElement>(".btn")]
        .filter((el) => el.getBoundingClientRect().height > 0)
        .filter((el) => el.getBoundingClientRect().height < 43.5)
        .map((el) => `${describe(el)} ${Math.round(el.getBoundingClientRect().height)}px`),
    };
  });
}

async function expectItFits(panel: Locator, viewportWidth: number) {
  const m = await measure(panel);
  expect.soft(m.buttons, "the panel is missing its buttons, so there is nothing to measure").toBeGreaterThan(8);
  expect.soft(m.scrollWidth, `the panel scrolls sideways (content box is ${m.panel})`).toBeLessThanOrEqual(m.clientWidth);
  expect.soft(m.buttonsOutside, `buttons outside the panel (content box ${m.panel})`).toEqual([]);
  expect.soft(m.othersOutside, `elements outside the panel (content box ${m.panel})`).toEqual([]);
  expect.soft(m.spilling, `text running out of its box`).toEqual([]);
  if (viewportWidth < 768) expect.soft(m.small, `under 44px on a phone: ${m.small}`).toEqual([]);
}

test.describe("the panel beside a conversation keeps everything inside it", () => {
  for (const locale of LOCALES) {
    test(`in ${locale}`, async ({ page, request }) => {
      const panel = await panelFor(page, request, locale);
      await expectItFits(panel, page.viewportSize()!.width);
    });

    // The narrowest screen the interface claims to fit, on either project: a
    // phone, or a desktop window dragged down to the size of one.
    test(`in ${locale}, at 320px`, async ({ page, request }) => {
      await page.setViewportSize({ width: 320, height: 700 });
      const panel = await panelFor(page, request, locale);
      await expectItFits(panel, 320);
    });
  }

  // What a model's server is called is whatever its owner called it, and the
  // sentence about a failed attempt to reach it quotes the address. Two
  // places in the panel show that sentence, each in a paragraph of its own.
  const text = messages("en");
  const failures: Record<string, (panel: Locator, page: Page) => Promise<void>> = {
    "remembering the story": (panel) =>
      panel.getByRole("button", { name: text.facts.extractButton, exact: true }).click(),
    "setting a backdrop": async (panel, page) => {
      const chooser = page.waitForEvent("filechooser");
      await panel.getByRole("button", { name: text.wallpaper.replace, exact: true }).click();
      await (await chooser).setFiles({ name: "backdrop.png", mimeType: "image/png", buffer: PNG });
    },
  };
  for (const [what, act] of Object.entries(failures)) {
    test(`an error that quotes a long address stays inside it, ${what}`, async ({ page, request }) => {
      await page.setViewportSize({ width: 320, height: 700 });
      const unreachable = (route: Route) => route.request().method() === "POST"
        ? route.fulfill({
          status: 502,
          contentType: "application/json",
          body: JSON.stringify({
            error: "Cannot reach the model.",
            kind: "unreachable",
            upstream_url: "http://gamingpcinthelivingroomofthefamilyhomestead.example.net:5001/v1",
          }),
        })
        : route.continue();
      await page.route("**/api/conversations/*/memories/extract", unreachable);
      await page.route("**/api/conversations/*/wallpaper", unreachable);

      const panel = await panelFor(page, request, "en");
      await act(panel, page);
      await expect(panel.getByText("gamingpcinthelivingroomofthefamilyhomestead")).toBeVisible();
      await expectItFits(panel, 320);
    });
  }
});
