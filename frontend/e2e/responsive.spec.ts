import { expect, test, type Locator, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { API, GATE_PASSWORD, GATED } from "../playwright.config";
import { MOCK, addModel, cardPortrait, chat, conversationWithReply, inLocale, makeCharacter, makeConversation, misfits } from "./fixtures";

/** What runs off the right edge of a page this wide: elements past it, the page's width, how far <main> slides. */
function pastTheEdge(page: Page, width: number) {
  return page.evaluate((seen) => {
    const guilty: string[] = [];
    for (const el of document.querySelectorAll("body *")) {
      const box = el.getBoundingClientRect();
      const inARail = el.closest(".overflow-x-auto, .card-tags");
      if (box.width > 0 && box.right > seen + 1 && !inARail
          && getComputedStyle(el).position !== "fixed") {
        guilty.push(el.tagName.toLowerCase() + "." + String(el.className).split(" ")[0]);
      }
    }
    const main = document.querySelector("main");
    const sideways = main ? main.scrollWidth - main.clientWidth : 0;
    return { page: document.documentElement.scrollWidth, guilty: [...new Set(guilty)], sideways };
  }, width);
}

/** Whether a page fits a phone's screen is something no type check or build sees. */
test.describe("the main page fits the screen it is on", () => {
  for (const width of [320, 390, 414, 768, 1280]) {
    test(`nothing runs off the side at ${width}px`, async ({ page, request }) => {
      await makeCharacter(request);
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/");
      await page.waitForLoadState("networkidle");

      const overflow = await pastTheEdge(page, width);

      expect(overflow.guilty, `elements past the right edge: ${overflow.guilty}`).toEqual([]);
      expect(overflow.page).toBeLessThanOrEqual(width);
    });
  }

  test("buttons are big enough to hit with a thumb", async ({ page, request }) => {
    await makeCharacter(request);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const small = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>(".btn")]
        .filter((el) => el.getBoundingClientRect().height > 0)
        .filter((el) => el.getBoundingClientRect().height < 44)
        .map((el) => `${el.textContent?.trim().slice(0, 20)} ${Math.round(el.getBoundingClientRect().height)}px`));

    expect(small, `under 44px: ${small}`).toEqual([]);
  });
});

/** Beside the story the panel takes 320px and the sidebar 224: open from the start on a tablet, it leaves a sliver. */
test.describe("a conversation opens with room to write in", () => {
  for (const width of [768, 834, 1024, 1280]) {
    test(`at ${width}px`, async ({ page, request }) => {
      const convo = await conversationWithReply(request);
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/#/chat/${convo.id}`);

      const box = page.getByPlaceholder(/^Write to Vane/);
      await expect(box).toBeVisible();
      expect((await box.boundingBox())!.width, "the message box is crushed").toBeGreaterThanOrEqual(240);
      // Where there is room for it, it is open beside the story.
      await expect(page.locator("aside:has(textarea)")).toHaveCount(width >= 1024 ? 1 : 0);
    });
  }
});

/** A card's pages and the personas at the widths phones have, in a language. */
async function expectTheCardPagesFit(page: Page, cardId: string, widths: number[]) {
  for (const width of widths) {
    await page.setViewportSize({ width, height: 800 });
    for (const route of [`/characters/${cardId}`, `/characters/${cardId}/edit`, "/personas"]) {
      await page.goto(`/#${route}`);
      await expect(page.locator("main h1")).toBeVisible();
      await page.waitForLoadState("networkidle");

      const overflow = await pastTheEdge(page, width);

      expect.soft(overflow.guilty, `${route} at ${width}px: elements past the right edge`).toEqual([]);
      expect.soft(overflow.page, `${route} at ${width}px`).toBeLessThanOrEqual(width);
      expect.soft(overflow.sideways, `${route} at ${width}px slides sideways`).toBeLessThanOrEqual(1);
    }
  }
}

// A name is whatever its owner typed: a handle, or a German compound, is one long word.
test("a one-word name breaks rather than pushing a page off the side of a phone", async ({ page, request }) => {
  const card = await makeCharacter(request, { name: "Nachtigallenkoniginnenthron" });
  await page.route("**/api/personas", (route) => route.fulfill({
    json: [{ id: "long", name: "xX_DarkLordOfShadowsAndMore_Xx", description: "", is_default: true, avatar_url: null }],
  }));

  await expectTheCardPagesFit(page, card.id, [320, 375, 412]);
});

// Buttons that sit side by side in English may not in French or German.
test.describe("a card's pages and the personas fit a phone in every language", () => {
  for (const locale of ["en", "fr", "de", "es"]) {
    test(`in ${locale}`, async ({ page, request }) => {
      const card = await makeCharacter(request);
      await page.addInitScript((chosen) => localStorage.setItem("evermind:locale", chosen), locale);

      await expectTheCardPagesFit(page, card.id, [320, 360]);
    });
  }
});

// The offer to re-read a card made before has two buttons whose labels are whole sentences.
test.describe("the offer to re-read a card fits a phone in every language", () => {
  for (const locale of ["en", "fr", "de", "es"]) {
    test(`in ${locale}`, async ({ page, request }) => {
      const strings = JSON.parse(readFileSync(path.join(import.meta.dirname, "..", "src", "i18n", "locales", `${locale}.json`), "utf8"));
      const card = await makeCharacter(request, { name: "Mirela", description: "A lighthouse keeper.", greeting: "The lamp is lit." });
      await request.post(`${API}/api/characters/${card.id}/avatar`, {
        multipart: { file: { name: "mirela.png", mimeType: "image/png", buffer: cardPortrait({
          spec: "chara_card_v2", spec_version: "2.0",
          data: { name: "Mirela", description: "A lighthouse keeper.", first_mes: "The lamp is lit." },
        }) } },
      });
      await page.addInitScript((chosen) => localStorage.setItem("evermind:locale", chosen), locale);

      for (const width of [320, 360, 390]) {
        await page.setViewportSize({ width, height: 800 });
        await page.goto(`/#/characters/${card.id}/edit`);
        const keep = page.getByRole("button", { name: strings.characters.reread.keep });
        await expect(keep).toBeVisible();
        await page.waitForLoadState("networkidle");

        const overflow = await pastTheEdge(page, width);
        expect.soft(overflow.guilty, `at ${width}px: elements past the right edge`).toEqual([]);
        expect.soft(overflow.page, `at ${width}px`).toBeLessThanOrEqual(width);
        expect.soft(overflow.sideways, `at ${width}px slides sideways`).toBeLessThanOrEqual(1);
        for (const button of [keep, page.getByRole("button", { name: strings.characters.reread.reread })]) {
          // A label cut by the button's own edge stays inside the page, so it is measured too.
          const cut = await button.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
          expect.soft(cut, `at ${width}px a button's label is cut`).toBe(false);
        }
      }
    });
  }
});

// Text set twice as large, as a person who reads with large text sets it: long German and Spanish
// words then fill a line of their own, and must break inside the banner rather than run past it.
test.describe("the offer to re-read a card keeps its words inside it with large text", () => {
  for (const locale of ["de", "es"]) {
    test(`in ${locale}`, async ({ page, request }) => {
      const strings = JSON.parse(readFileSync(path.join(import.meta.dirname, "..", "src", "i18n", "locales", `${locale}.json`), "utf8"));
      const card = await makeCharacter(request, { name: "Mirela", description: "A lighthouse keeper.", greeting: "The lamp is lit." });
      await request.post(`${API}/api/characters/${card.id}/avatar`, {
        multipart: { file: { name: "mirela.png", mimeType: "image/png", buffer: cardPortrait({
          spec: "chara_card_v2", spec_version: "2.0",
          data: { name: "Mirela", description: "A lighthouse keeper.", first_mes: "The lamp is lit.", scenario: "A tower." },
        }) } },
      });
      await page.addInitScript((chosen) => {
        localStorage.setItem("evermind:locale", chosen);
        document.addEventListener("DOMContentLoaded", () => { document.documentElement.style.fontSize = "200%"; });
      }, locale);
      await page.setViewportSize({ width: 320, height: 800 });
      await page.goto(`/#/characters/${card.id}/edit`);
      await expect(page.getByRole("button", { name: strings.characters.reread.keep })).toBeVisible();
      await page.waitForLoadState("networkidle");

      const banner = page.locator("section", { hasText: strings.characters.reread.title });
      const outside = await banner.evaluate((section) => {
        const edge = section.getBoundingClientRect().right;
        return [...section.querySelectorAll("*")].flatMap((el) => {
          const box = el.getBoundingClientRect();
          const cut = el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX === "visible";
          return box.right > edge + 1 || cut ? [`${el.tagName.toLowerCase()} "${(el.textContent ?? "").slice(0, 40)}"`] : [];
        });
      });
      expect(outside, "past the banner's edge, or past their own").toEqual([]);
    });
  }
});

// Typed by hand from a phone, "--pull" broken across two lines reads as "-- pull", which fails.
test("the update command stays on one line, to be read and typed as it is", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.route("**/api/update", (route) => route.fulfill({
    json: { current: "3.0.0", kind: "docker", command: "docker compose up -d --pull always" },
  }));
  await page.route("https://api.github.com/repos/Phobetore/Evermind/releases/latest", (route) => route.fulfill({
    json: { tag_name: "v99.0.0", html_url: "https://github.com/Phobetore/Evermind/releases/tag/v99.0.0" },
    headers: { "access-control-allow-origin": "*" },
  }));
  await page.goto("/#/settings");
  const command = page.locator("main code");
  await expect(command).toHaveText("docker compose up -d --pull always");

  const lines = await command.evaluate((el) => {
    const text = document.createRange();
    text.selectNodeContents(el);
    return text.getClientRects().length;
  });

  expect(lines, "the command breaks across lines").toBe(1);
  expect((await pastTheEdge(page, 320)).page).toBeLessThanOrEqual(320);
});

// What a card carries is whatever its author typed, and the API bounds neither the tagline nor a tag:
// the tile, the row of tags, the library and the editor's chips each cut them, or the page widens.
const madeWide: string[] = [];
test.afterEach(async ({ request }) => {
  for (const id of madeWide.splice(0)) await request.delete(`${API}/api/characters/${id}`);
});

test("a card's long tagline and tags widen neither the home page, the library nor the editor", async ({ page, request }, testInfo) => {
  const name = `Wide tags ${Date.now()}`;
  const tagline = "W".repeat(10_000);
  const longTag = "L".repeat(10_000);
  const tags = [longTag, ...Array.from({ length: 19 }, (_, i) => `tag ${i + 2}`)];
  const card = await makeCharacter(request, { name, tagline, tags });
  const untagged = await makeCharacter(request, { name: `${name} untagged`, tagline, tags: [] });
  madeWide.push(card.id, untagged.id);
  const title = "L".repeat(2_000);
  const sideways = (target: Page) => target.evaluate(() => {
    const root = document.scrollingElement!;
    return root.scrollWidth - root.clientWidth;
  });

  const home = async () => {
    await page.goto("/");
    await page.getByPlaceholder("Search").fill(name);
    const chip = page.locator("button", { has: page.locator(`[title="${title}"]`) });
    await expect(chip).toBeVisible();
    expect(await sideways(page), "the home page slides sideways").toBeLessThanOrEqual(0);
    const rail = (await chip.locator("xpath=..").boundingBox())!;
    for (const box of await Promise.all((await chip.locator("xpath=../button").all()).map((b) => b.boundingBox()))) {
      expect(box!.width, "a chip is wider than its row").toBeLessThanOrEqual(rail.width + 1);
    }
    expect(await page.locator("#main").evaluate((el) => el.scrollWidth - el.clientWidth), "the home page slides sideways")
      .toBeLessThanOrEqual(0);
    // The tile shows its tagline and tags at every width: on a phone the tags in a row that slides.
    const narrow = page.viewportSize()!.width < 640;
    const tile = page.locator(`a[href$="/characters/${card.id}"]`);
    const cut = async (tale: Locator, lines: number, what: string) => {
      await expect(tale).toBeVisible();
      const { height, line } = await tale.evaluate((el) => ({
        height: el.getBoundingClientRect().height,
        line: parseFloat(getComputedStyle(el).lineHeight),
      }));
      expect(height, what).toBeLessThanOrEqual(line * (lines + 0.5));
    };
    await cut(tile.locator("p.italic"), 2, "the tile's tagline is cut at two lines");
    await cut(page.locator(`a[href$="/characters/${untagged.id}"] p.italic`), narrow ? 3 : 2,
      `the tagline of a tile without tags is cut at ${narrow ? "three" : "two"} lines`);
    const tileChip = tile.locator("span", { has: page.locator(`[title="${title}"]`) }).last();
    await expect(tileChip).toBeVisible();
    const tileBox = (await tile.boundingBox())!;
    const chipBox = (await tileChip.boundingBox())!;
    expect(chipBox.x + chipBox.width, "the tile's chip runs past the tile").toBeLessThanOrEqual(tileBox.x + tileBox.width);
    expect(chipBox.width, "the tile's chip is as wide as the tile").toBeLessThan(tileBox.width);
  };
  const library = async () => {
    await page.route("**/api/library", (route) => route.fulfill({
      json: [{
        filename: "wide.json", has_avatar: false,
        card: { spec: "chara_card_v2", spec_version: "2.0", data: {
          name: "Wide shelf", tags, extensions: { evermind: { tagline } },
        } },
      }],
    }));
    await page.goto("/");
    await page.getByTitle("Starter library").click();
    const dialog = page.getByRole("dialog");
    const row = dialog.locator(".rounded-xl", { has: page.getByRole("heading", { name: "Wide shelf" }) });
    await expect(row).toBeVisible();
    const panel = dialog.locator(".panel");
    expect(await panel.evaluate((el) => el.scrollWidth - el.clientWidth), "the library slides sideways").toBeLessThanOrEqual(0);
    await expect(row.getByRole("button", { name: "Show the 12 other tags" })).toBeVisible();
    expect(await row.locator("span[title]").count(), "eight tags at first").toBe(8);
    const { height, line } = await row.locator("p.italic").evaluate((el) => ({
      height: el.getBoundingClientRect().height,
      line: parseFloat(getComputedStyle(el).lineHeight),
    }));
    expect(height, "the shelf's tagline is cut at three lines").toBeLessThanOrEqual(line * 3.5);
    await page.unroute("**/api/library");
  };
  const editor = async () => {
    await page.goto(`/#/characters/${card.id}/edit`);
    const remove = page.getByRole("button", { name: /^Remove L{20}/ });
    await expect(remove).toBeVisible();
    expect(await sideways(page), "the editor slides sideways").toBeLessThanOrEqual(0);
    const box = (await remove.boundingBox())!;
    const view = page.viewportSize()!;
    expect(box.x + box.width, "the remove button is out of the window").toBeLessThanOrEqual(view.width);
    await remove.click();
    await expect(remove).toHaveCount(0);
  };

  await home();
  await library();
  await editor();
  if (testInfo.project.name === "phone") {
    // A phone on its side is past sm: the tile shows its first three tags, the row wraps.
    await page.setViewportSize({ width: 915, height: 412 });
    await home();
    await library();
    await editor();
  }
});

// Every language, on the phones of today and the smallest one still sold, at the text size a phone
// comes with: nothing past the edge, no sentence squeezed into a column beside a control, and no
// placeholder cut.
const PHONES = [{ width: 390, height: 844 }, { width: 320, height: 640 }];
const LOCALES = ["en", "fr", "de", "es"];
const wordsOf = (locale: string) =>
  JSON.parse(readFileSync(path.join(import.meta.dirname, "..", "src", "i18n", "locales", `${locale}.json`), "utf8"));

/** How much wider a one-line placeholder is than the room inside its field, measured in the field's
 *  own font; or, for a textarea, how much taller its placeholder is than the box. */
const placeholderOver = (field: Locator) => field.evaluate(async (el: HTMLInputElement | HTMLTextAreaElement) => {
  await document.fonts.ready;
  const style = getComputedStyle(el);
  const probe = document.createElement("div");
  probe.textContent = el.placeholder;
  const many = el.tagName === "TEXTAREA";
  Object.assign(probe.style, {
    font: style.font, letterSpacing: style.letterSpacing, lineHeight: style.lineHeight,
    position: "absolute", visibility: "hidden", whiteSpace: many ? "pre-wrap" : "pre", overflowWrap: "break-word",
    width: many ? `${el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)}px` : "auto",
  });
  document.body.append(probe);
  const box = probe.getBoundingClientRect();
  probe.remove();
  return many
    ? box.height - (el.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom))
    : box.width - (el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight));
});

/** Whether a sentence is squeezed beside what shares its row: on more than one line, and narrower
 *  than half of the row's room. */
const squeezed = (sentence: Locator) => sentence.evaluate((el) => {
  const row = el.parentElement!;
  const style = getComputedStyle(row);
  const room = row.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  const text = document.createRange();
  text.selectNodeContents(el);
  const lines = new Set([...text.getClientRects()].map((r) => Math.round(r.top))).size;
  return lines > 1 && el.getBoundingClientRect().width < room / 2;
});

test.describe("on a phone, in every language", () => {
  for (const locale of LOCALES) {
    test(`the new card's page fits, in ${locale}`, async ({ page, request }) => {
      const words = wordsOf(locale);
      // Two AIs at least, for the assistant's select to be there.
      await addModel(request, { base_url: MOCK, model: "e2e-second", name: "Second" });
      await makeCharacter(request);
      await inLocale(page, locale);
      for (const size of PHONES) {
        await page.setViewportSize(size);
        await page.goto("/#/characters/new");
        const hint = page.getByText(words.characters.assist.fieldsKeptHint, { exact: true });
        await expect(hint).toBeVisible();
        expect(await misfits(page), `at ${size.width}px`).toEqual([]);
        expect(await squeezed(hint), `the hint is squeezed at ${size.width}px`).toBe(false);
        for (const placeholder of [
          words.characters.assist.briefPlaceholderCharacter, words.lorebook.keysPlaceholder, words.lorebook.contentPlaceholder,
        ]) {
          expect(await placeholderOver(page.getByPlaceholder(placeholder, { exact: true })),
            `"${placeholder.slice(0, 30)}" is cut at ${size.width}px`).toBeLessThanOrEqual(0.5);
        }
      }
      // An entry added, its settings opened: the secondary keywords' field. After the rest, as the
      // page keeps its draft, entry included, from one width to the next.
      const secondary = words.lorebook.secondaryKeysPlaceholder;
      for (const size of PHONES) {
        await page.setViewportSize(size);
        await page.goto("/#/characters/new");
        const settings = page.getByRole("button", { name: words.lorebook.settingsFor.replace("{name}", "harbour"), exact: true });
        if (!(await settings.count())) {
          const keys = page.getByPlaceholder(words.lorebook.keysPlaceholder, { exact: true });
          await keys.fill("harbour");
          await keys.press("Enter");
          await page.getByPlaceholder(words.lorebook.contentPlaceholder, { exact: true }).fill("The harbour freezes in winter.");
          await page.getByRole("button", { name: words.lorebook.addEntryButton, exact: true }).click();
        }
        // The same address again keeps the page as it was: the settings may be open already.
        if ((await settings.first().getAttribute("aria-expanded")) !== "true") await settings.first().click();
        expect(await placeholderOver(page.getByPlaceholder(secondary, { exact: true })),
          `"${secondary.slice(0, 30)}" is cut at ${size.width}px`).toBeLessThanOrEqual(0.5);
      }
    });

    test(`a reply that failed says so across the width, in ${locale}`, async ({ page, request }) => {
      const words = wordsOf(locale);
      const convo = await makeConversation(request);
      await request.patch(`${API}/api/conversations/${convo.id}`, { data: { author_note: "MOCK_FAILS" } });
      await chat(request, { conversation_id: convo.id, mode: "send", content: "Anyone?" });
      await request.patch(`${API}/api/conversations/${convo.id}`, { data: { author_note: "" } });
      await inLocale(page, locale);
      for (const size of PHONES) {
        await page.setViewportSize(size);
        await page.goto(`/#/chat/${convo.id}`);
        await expect(page.getByRole("button", { name: words.chat.errors.retryButton, exact: true })).toBeVisible();
        const sentence = page.locator(".chat-banner [role=alert]");
        expect(await misfits(page), `at ${size.width}px`).toEqual([]);
        expect(await squeezed(sentence), `the sentence is squeezed at ${size.width}px`).toBe(false);
      }
    });

    test(`the settings and the instructions fit, in ${locale}`, async ({ page }) => {
      const words = wordsOf(locale);
      await inLocale(page, locale);
      for (const size of PHONES) {
        await page.setViewportSize(size);
        await page.goto("/#/settings");
        const instructions = page.getByPlaceholder(words.settings.globalInstructionsPlaceholder, { exact: true });
        await expect(instructions).toBeVisible();
        expect(await misfits(page), `at ${size.width}px`).toEqual([]);
        expect(await placeholderOver(instructions), `the instructions' placeholder is cut at ${size.width}px`).toBeLessThanOrEqual(0.5);
      }
    });

    test(`the access section fits, in ${locale}`, async ({ page }) => {
      const words = wordsOf(locale);
      await page.goto(`${GATED}/#/settings`);
      await page.getByLabel(/password/i).fill(GATE_PASSWORD);
      await page.getByRole("button", { name: /enter/i }).click();
      // The password page has a heading of its own: the page behind it is there once its field is gone.
      await expect(page.getByLabel(/password/i)).toHaveCount(0);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await page.evaluate((chosen) => localStorage.setItem("evermind:locale", chosen), locale);
      for (const size of PHONES) {
        await page.setViewportSize(size);
        await page.reload();
        await expect(page.getByRole("button", { name: words.settings.access.logoutEverywhere })).toBeVisible();
        expect(await misfits(page), `at ${size.width}px`).toEqual([]);
      }
    });

    test(`a service's form keeps its key's placeholder whole, in ${locale}`, async ({ page, request }) => {
      const words = wordsOf(locale);
      const made = await request.post(`${API}/api/models`, {
        data: {
          service: { provider: "openai-compatible", base_url: `${MOCK}`, api_key: `sk-form-${Date.now()}` },
          models: [{ model: `e2e-form-${Date.now()}`, name: `Form ${Date.now()}` }],
        },
      });
      const ai = (await made.json()).models[0];
      await inLocale(page, locale);
      try {
        for (const size of PHONES) {
          await page.setViewportSize(size);
          await page.goto(`/#/settings/ai/${ai.id}`);
          await page.reload();
          await page.locator("details summary").click();
          await page.getByRole("button", { name: words.ai.page.edit, exact: true }).click();
          const key = page.getByPlaceholder(words.ai.service.keyKeep, { exact: true });
          await expect(key).toBeVisible();
          expect(await placeholderOver(key), `the key's placeholder is cut at ${size.width}px`).toBeLessThanOrEqual(0.5);
          expect(await misfits(page, "dialog[open]"), `at ${size.width}px`).toEqual([]);
        }
      } finally {
        await request.delete(`${API}/api/models/${ai.id}`);
      }
    });
  }
});
