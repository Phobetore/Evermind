import { expect, test } from "@playwright/test";
import { makeCharacter } from "./fixtures";

test("the home page finds a card by its words whatever their case, and a % is a percent sign", async ({ page, request }) => {
  const stamp = Date.now();
  const sung = await makeCharacter(request, { name: `Éloïse ${stamp}`, tagline: "Sings at 100% of her voice", kind: "scenario" });
  const roomed = await makeCharacter(request, { name: `Mira ${stamp}`, description: "Keeps rooms 1000 to 1050." });
  await page.goto("/#/");
  const shown = (card: { name: string }) => page.locator("main").getByRole("heading", { name: card.name });
  const search = page.getByPlaceholder("Search by name, mood…");

  // The one left out first: what is shown before the search has been made is everything.
  await search.fill(`ÉLOÏSE ${stamp}`);
  await expect(shown(roomed)).toBeHidden();
  await expect(shown(sung)).toBeVisible();

  await search.fill("100%");
  await expect(shown(roomed)).toBeHidden();
  await expect(shown(sung)).toBeVisible();

  await search.fill(` ${stamp} `);
  await expect(shown(roomed)).toBeVisible();
  await page.getByRole("button", { name: "Scenarios" }).click();
  await expect(shown(roomed)).toBeHidden();
  await expect(shown(sung)).toBeVisible();
});
