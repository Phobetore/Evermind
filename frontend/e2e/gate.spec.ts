import { expect, test, type Page } from "@playwright/test";
import { GATE_PASSWORD, GATED } from "../playwright.config";

/**
 * Everything here runs against the second server, the one started with an
 * access password. The other tests never meet the password: they use the
 * server that has none.
 */
test.use({ baseURL: GATED });

async function enter(page: Page, password: string) {
  await page.getByLabel(/password/i).fill(password);
  await page.getByRole("button", { name: /enter/i }).click();
}

test("a locked page asks for the password, then opens where it was going", async ({ page }) => {
  await page.goto("/#/settings");
  await expect(page).toHaveURL(/#\/login\?from=%2Fsettings$/);

  await enter(page, GATE_PASSWORD);
  await expect(page).toHaveURL(/#\/settings$/);

  // The session is a cookie, not something the page holds, so a reload
  // neither asks again nor loses the page.
  await page.reload();
  await expect(page).toHaveURL(/#\/settings$/);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
});

test("a wrong password is refused and stays on the login", async ({ page }) => {
  await page.goto("/#/login");
  await enter(page, "not-the-password");

  await expect(page.getByText(/access denied/i)).toBeVisible();
  await expect(page).toHaveURL(/#\/login/);
  // The field is emptied so the next attempt starts clean, and the way in
  // stays shut: nothing behind the login has been loaded.
  await expect(page.getByLabel(/password/i)).toHaveValue("");
  expect((await page.request.get(`${GATED}/api/characters`)).status()).toBe(401);
});

test("a browser that keeps no cookie is told so, not sent back to an empty login", async ({ page, context }) => {
  // Phones with strict cookie settings accept the password and drop the
  // session cookie. The server says yes, the next call arrives without a
  // session, and the way in shuts again: without a word, that looks like a
  // login that does nothing.
  await page.route("**/api/gate", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const response = await route.fetch();
    const headers = { ...response.headers() };
    delete headers["set-cookie"];
    await route.fulfill({ response, headers });
    // fetch() goes through the context's own cookie jar, which would keep the
    // cookie it was just given: clear it, so the page ends up without one.
    await context.clearCookies();
  });

  await page.goto("/#/login");
  await enter(page, GATE_PASSWORD);

  await expect(page.getByText(/did not keep the sign-in/i)).toBeVisible();
  await expect(page).toHaveURL(/#\/login/);
  expect((await context.cookies()).find((c) => c.name === "evermind_session")).toBeUndefined();
  // The spinner is gone and the form is still there to try again with.
  await expect(page.getByRole("button", { name: /enter/i })).toBeEnabled();

  // Once the browser keeps the cookie, the same form lets the device in.
  await page.unroute("**/api/gate");
  await enter(page, GATE_PASSWORD);
  await expect(page).toHaveURL(`${GATED}/#/`);
});

test("the login never sends anyone off-site", async ({ page }) => {
  // A link anyone can write: "//evil.example" starts with a slash and still
  // leads to another site when it is followed as an address.
  await page.goto("/#/login?from=%2F%2Fevil.example");
  await enter(page, GATE_PASSWORD);

  await expect(page).toHaveURL(`${GATED}/#/`);
  expect(new URL(page.url()).origin).toBe(GATED);
});

test("the session cookie outlives the browser and does not need https", async ({ page, context }) => {
  // A phone reaches Evermind over http, by the address of the computer on the
  // network. A cookie marked Secure would be dropped there, and one without an
  // expiry would be gone each time the browser is closed.
  await page.goto("/#/login");
  await enter(page, GATE_PASSWORD);
  await expect(page).toHaveURL(`${GATED}/#/`);

  const cookie = (await context.cookies()).find((c) => c.name === "evermind_session");
  expect(cookie, "no session cookie was set").toBeDefined();
  expect(cookie!.secure).toBe(false);
  expect(cookie!.httpOnly).toBe(true);
  // -1 is how a session cookie, which ends with the browser, is reported.
  expect(cookie!.expires).toBeGreaterThan(Date.now() / 1000);
});

test("signing out really ends the session", async ({ page, context, request }) => {
  await page.goto("/#/settings");
  await enter(page, GATE_PASSWORD);
  await expect(page).toHaveURL(/#\/settings$/);

  // Kept to be replayed afterwards: what matters is that the server stopped
  // honouring it, not that the page forgot it.
  const cookie = (await context.cookies()).find((c) => c.name === "evermind_session");
  expect(cookie, "no session cookie was set").toBeDefined();
  const replayed = { cookie: `evermind_session=${cookie!.value}` };
  expect((await request.get(`${GATED}/api/characters`, { headers: replayed })).status(),
    "the cookie did not work before signing out, so replaying it proves nothing").toBe(200);

  const entries = await page.evaluate(() => history.length);
  await page.getByRole("button", { name: /sign out of this device/i }).click();
  // A clean login address, with nothing about where the person was going, and
  // taking the place of the settings page in the history instead of stacking
  // on it: Back must not lead into a page that is closed.
  await expect(page).toHaveURL(/#\/login$/);
  expect(await page.evaluate(() => history.length)).toBe(entries);

  await page.reload();
  await expect(page).toHaveURL(/#\/login/);
  await expect(page.getByLabel(/password/i)).toBeVisible();

  const after = await request.get(`${GATED}/api/characters`, { headers: replayed });
  expect(after.status()).toBe(401);
});

test("signing in again after signing out lands on the home page", async ({ page }) => {
  await page.goto("/#/settings");
  await enter(page, GATE_PASSWORD);
  await expect(page).toHaveURL(/#\/settings$/);

  await page.getByRole("button", { name: /sign out of this device/i }).click();
  await expect(page).toHaveURL(/#\/login$/);

  // The person left on purpose: there is no page to take them back to, with or
  // without a reload in between.
  await page.reload();
  await expect(page.getByLabel(/password/i)).toBeVisible();
  await enter(page, GATE_PASSWORD);
  await expect(page).toHaveURL(`${GATED}/#/`);
});

test("a session that ends after signing back in remembers where it was", async ({ page }) => {
  await page.goto("/#/settings");
  await enter(page, GATE_PASSWORD);
  await page.getByRole("button", { name: /sign out of this device/i }).click();
  await expect(page).toHaveURL(/#\/login$/);
  await enter(page, GATE_PASSWORD);
  await expect(page).toHaveURL(`${GATED}/#/`);

  // Ended from outside, as another device signing everything out would: this
  // is not leaving on purpose, and the way back is kept again.
  expect((await page.request.delete(`${GATED}/api/gate/sessions`)).status()).toBe(204);
  await page.goto("/#/personas");
  await expect(page).toHaveURL(/#\/login\?from=%2Fpersonas$/);
});

test("signing out lands on the login even when the server cannot be asked afterwards", async ({ page }) => {
  await page.goto("/#/settings");
  await enter(page, GATE_PASSWORD);
  await expect(page).toHaveURL(/#\/settings$/);

  // The sign-out itself gets through, and the question that follows it, whether
  // this device is still in, does not. The device is out all the same: the
  // cookie is gone.
  await page.route("**/api/gate", (route) =>
    route.request().method() === "GET" ? route.abort("failed") : route.continue(),
  );
  await page.getByRole("button", { name: /sign out of this device/i }).click();
  await expect(page).toHaveURL(/#\/login$/);
  await expect(page.getByLabel(/password/i)).toBeVisible();

  // It left on purpose, so there is still no page to go back to.
  await page.unroute("**/api/gate");
  await enter(page, GATE_PASSWORD);
  await expect(page).toHaveURL(`${GATED}/#/`);
});

test("signing out of every device lands on a clean login too", async ({ page }) => {
  await page.goto("/#/settings");
  await enter(page, GATE_PASSWORD);
  const entries = await page.evaluate(() => history.length);

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: /sign out every device/i }).click();

  await expect(page).toHaveURL(/#\/login$/);
  expect(await page.evaluate(() => history.length)).toBe(entries);
});

test("the API is locked without a session", async ({ request }) => {
  const r = await request.get(`${GATED}/api/characters`);
  expect(r.status()).toBe(401);
  expect(await r.json()).toEqual({ error: "Locked.", kind: "locked" });
});
