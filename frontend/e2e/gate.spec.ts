import { expect, test, type Page } from "@playwright/test";
import http from "node:http";
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

/** The server's answer to a sign-in sent in chunks, with no length, as a streaming proxy sends it. */
function signInInChunks(password: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request(`${GATED}/api/gate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (part) => (body += part));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
    });
    request.on("error", reject);
    // Written before the end: Node then sends it chunked.
    request.write(JSON.stringify({ password }));
    request.end();
  });
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

test("a sign-in that a proxy passes on without its length points at the proxy", { tag: "@desktop" }, async ({ page }) => {
  // The right password, refused for want of a length: "too long" alone would leave nothing to fix.
  const refused = await signInInChunks(GATE_PASSWORD);
  expect(refused.status).toBe(413);
  await page.route("**/api/gate", (route) =>
    route.request().method() === "POST"
      ? route.fulfill({ status: refused.status, contentType: "application/json", body: refused.body })
      : route.continue(),
  );

  await page.goto("/#/login");
  await enter(page, GATE_PASSWORD);

  await expect(page.getByText(/proxy/i)).toBeVisible();
  await expect(page).toHaveURL(/#\/login/);
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

test("the session cookie does not need https, and each opening renews it", async ({ page, context }) => {
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
  const inAYear = Date.now() / 1000 + 365 * 86400;
  expect(cookie!.expires).toBeGreaterThan(inAYear);

  // A phone used every week is never asked again: a cookie near its end, as one
  // last renewed long ago would be, comes back whole from opening Evermind.
  await context.addCookies([{ ...cookie!, expires: Math.round(Date.now() / 1000) + 3600 }]);
  const asked = page.waitForResponse((r) => r.url().endsWith("/api/gate") && r.request().method() === "GET");
  await page.reload();
  await asked;
  const renewed = (await context.cookies()).find((c) => c.name === "evermind_session");
  expect(renewed?.value).toBe(cookie!.value);
  expect(renewed!.expires).toBeGreaterThan(inAYear);
});

test("signing out really ends the session, and signing back in returns to the page", async ({ page, context, request }) => {
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
  // The login takes the place of the closed page in the history: Back does not lead into it.
  await expect(page).toHaveURL(/#\/login\?from=%2Fsettings$/);
  expect(await page.evaluate(() => history.length)).toBe(entries);
  expect((await context.cookies()).find((c) => c.name === "evermind_session")).toBeUndefined();
  expect((await request.get(`${GATED}/api/characters`, { headers: replayed })).status()).toBe(401);

  await page.reload();
  await enter(page, GATE_PASSWORD);
  await expect(page).toHaveURL(/#\/settings$/);
});

test("signing out every device signs this one out too", async ({ page, context }) => {
  await page.goto("/#/settings");
  await enter(page, GATE_PASSWORD);
  await expect(page).toHaveURL(/#\/settings$/);

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: /sign out every device/i }).click();
  await expect(page).toHaveURL(/#\/login\?from=%2Fsettings$/);
  expect((await context.cookies()).find((c) => c.name === "evermind_session")).toBeUndefined();
});

test("a session ended from another device leads to the login, and back", async ({ page, context, request }) => {
  await page.goto("/#/settings");
  await enter(page, GATE_PASSWORD);
  await expect(page).toHaveURL(/#\/settings$/);

  // This browser keeps its cookie, which no longer opens anything.
  const cookie = (await context.cookies()).find((c) => c.name === "evermind_session");
  const elsewhere = { cookie: `evermind_session=${cookie!.value}` };
  expect((await request.delete(`${GATED}/api/gate/sessions`, { headers: elsewhere })).status()).toBe(204);
  await page.goto("/#/personas");
  await expect(page).toHaveURL(/#\/login\?from=%2Fpersonas$/);
  await enter(page, GATE_PASSWORD);
  await expect(page).toHaveURL(/#\/personas$/);
});

test("the API is locked without a session", async ({ request }) => {
  const r = await request.get(`${GATED}/api/characters`);
  expect(r.status()).toBe(401);
  expect(await r.json()).toEqual({ error: "Locked.", kind: "locked" });
});
