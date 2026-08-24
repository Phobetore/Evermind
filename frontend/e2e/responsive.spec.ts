import { expect, test } from "@playwright/test";
import { makeCharacter } from "./fixtures";

/**
 * The page fitted its screen on a laptop and not on a phone, and neither the
 * typechecker nor the build has anything to say about that. Every number here
 * is one that was wrong at some point.
 */
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
