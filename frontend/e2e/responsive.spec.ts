import { expect, test, type Page } from "@playwright/test";
import { conversationWithReply, makeCharacter } from "./fixtures";

/** What runs off the right edge of a page this wide: elements past it, the page's width, how far <main> slides. */
function pastTheEdge(page: Page, width: number) {
  return page.evaluate((seen) => {
    const guilty: string[] = [];
    for (const el of document.querySelectorAll("body *")) {
      const box = el.getBoundingClientRect();
      const inARail = el.closest(".overflow-x-auto");
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
