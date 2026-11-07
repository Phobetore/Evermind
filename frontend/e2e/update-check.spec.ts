import { expect, test, type Page } from "@playwright/test";
import { API } from "../playwright.config";

/** Settings says when a newer release is out, which the page asks GitHub itself. */

const LATEST = "https://api.github.com/repos/Phobetore/Evermind/releases/latest";

/** GitHub as the page meets it: `tag` is the newest release, or nothing answers.
 *  What is returned fills with each time it is asked. */
async function github(page: Page, tag: string | null) {
  const asked: string[] = [];
  await page.unroute(LATEST);
  await page.route(LATEST, (route) => {
    asked.push(route.request().url());
    return tag
      ? route.fulfill({
          json: { tag_name: tag, html_url: `https://github.com/Phobetore/Evermind/releases/tag/${tag}` },
          headers: { "access-control-allow-origin": "*" },
        })
      : route.abort("internetdisconnected");
  });
  return asked;
}

test("a newer release is announced with the command that updates this installation", async ({
  page, request,
}) => {
  await github(page, "v99.0.0");
  const { command } = await (await request.get(`${API}/api/update`)).json();

  await page.goto("/#/settings");

  await expect(page.getByText("Evermind 99.0.0 is out.")).toBeVisible();
  await expect(page.locator("main code")).toHaveText(command);
  await expect(page.getByRole("link", { name: "What changed" }))
    .toHaveAttribute("href", "https://github.com/Phobetore/Evermind/releases/tag/v99.0.0");
});

test("with the check off nothing is asked until the button is, which says what came of it", async ({
  page, request,
}) => {
  const { current } = await (await request.get(`${API}/api/update`)).json();
  await request.put(`${API}/api/settings`, { data: { update_check: false } });
  try {
    const asked = await github(page, `v${current}`);
    await page.goto("/#/settings");
    await expect(page.getByRole("checkbox", { name: /ask GitHub/i })).not.toBeChecked();

    await page.getByRole("button", { name: "Check now" }).click();
    await expect(page.getByText("You are on the newest release.")).toBeVisible();
    expect(asked, "GitHub was asked before the button was pressed").toHaveLength(1);

    await github(page, null);
    await page.getByRole("button", { name: "Check now" }).click();
    await expect(page.getByText("Could not reach GitHub.")).toBeVisible();
  } finally {
    await request.put(`${API}/api/settings`, { data: { update_check: true } });
  }
});

test("switching the check off when that is not saved says so, and the box stays as stored", async ({ page }) => {
  await github(page, null);
  await page.route("**/api/settings", (route) => route.request().method() === "PUT"
    ? route.fulfill({ status: 500, contentType: "text/html", body: "<h1>Bad gateway</h1>" })
    : route.continue());
  await page.goto("/#/settings");
  const box = page.getByRole("checkbox", { name: /ask GitHub/i });
  await expect(box).toBeChecked();

  // The label takes the tap, as it does for a finger.
  await page.locator("main label", { has: box }).click();

  await expect(page.locator("main").getByRole("alert")).toHaveText("Evermind answered with an error (HTTP 500).");
  await expect(box).toBeChecked();
});
