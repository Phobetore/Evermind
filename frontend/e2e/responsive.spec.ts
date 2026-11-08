import { expect, test } from "@playwright/test";
import { conversationWithReply, makeCharacter } from "./fixtures";

/** Whether a page fits a phone's screen is something no type check or build sees. */
test.describe("the main page fits the screen it is on", () => {
  for (const width of [320, 390, 414, 768, 1280]) {
    test(`nothing runs off the side at ${width}px`, async ({ page, request }) => {
      await makeCharacter(request);
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/");
      await page.waitForLoadState("networkidle");

      const overflow = await page.evaluate((seen) => {
        const guilty: string[] = [];
        for (const el of document.querySelectorAll("body *")) {
          const box = el.getBoundingClientRect();
          const inARail = el.closest(".overflow-x-auto");
          if (box.width > 0 && box.right > seen + 1 && !inARail
              && getComputedStyle(el).position !== "fixed") {
            guilty.push(el.tagName.toLowerCase() + "." + String(el.className).split(" ")[0]);
          }
        }
        return { page: document.documentElement.scrollWidth, guilty: [...new Set(guilty)] };
      }, width);

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

/** The side panel beside the story takes 320px of it, and the sidebar 224 more: on a tablet, or a
 *  window half a screen wide, opening on it would leave a sliver of a box to write in. */
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
