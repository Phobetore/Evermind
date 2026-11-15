import { expect, test, type Page, type Request } from "@playwright/test";
import { API, GATE_PASSWORD, GATED } from "../playwright.config";
import {
  answer, conversationWithReply, makeCharacter, makeConversation, PNG, policyViolations, replyEnds, watchPolicy,
} from "./fixtures";

/** The policy the server sends with every page, and what the app itself does under it: a page that
 *  broke its own policy would lose a picture, a font or a call without a word to anyone. */

const LATEST = "https://api.github.com/repos/Phobetore/Evermind/releases/latest";

// The cards each test sows, deleted after it with their conversations: the home page of every
// later test would draw them.
const made: string[] = [];
test.afterEach(async ({ request }) => {
  for (const id of made.splice(0)) await request.delete(API + "/api/characters/" + id);
});

async function noViolations(page: Page, where: string) {
  expect(await policyViolations(page), `the policy was broken on ${where}`).toEqual([]);
}

test("no page of the app breaks the policy it is served with @desktop", async ({ page, request }) => {
  await watchPolicy(page);
  // GitHub as update-check.spec.ts answers for it: the check is a call the policy must allow.
  const asked: string[] = [];
  await page.route(LATEST, (route) => {
    asked.push(route.request().url());
    return route.fulfill({
      json: { tag_name: "v99.0.0", html_url: "https://github.com/Phobetore/Evermind/releases/tag/v99.0.0" },
      headers: { "access-control-allow-origin": "*" },
    });
  });

  const served = await page.goto("/");
  expect(served?.headers()["content-security-policy"]).toBeTruthy();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await noViolations(page, "the home page");

  const character = await makeCharacter(request);
  made.push(character.id);
  await page.goto(`/#/characters/${character.id}`);
  await expect(page.getByRole("heading", { level: 1, name: "Vane" })).toBeVisible();
  await noViolations(page, "a card's page");

  await page.goto(`/#/characters/${character.id}/edit`);
  await page.locator('input[type="file"]').setInputFiles({ name: "face.png", mimeType: "image/png", buffer: PNG });
  // The preview of a chosen portrait is a blob: address.
  await expect(page.locator('img[src^="blob:"]')).toBeVisible();
  await noViolations(page, "a card's form with a portrait chosen");

  const convo = await conversationWithReply(request);
  made.push(convo.character_id);
  await page.goto(`/#/chat/${convo.id}`);
  await expect(page.locator(`[data-message-id="${convo.messages.at(-1).id}"]`)).toBeVisible();
  await noViolations(page, "a conversation");

  await page.goto("/#/settings");
  await expect(page.getByText("Evermind 99.0.0 is out.")).toBeVisible();
  expect(asked, "the update check never reached the page's route").not.toHaveLength(0);
  await noViolations(page, "the settings");

  await page.goto("/#/personas");
  await expect(page.getByRole("button", { name: "New persona" })).toBeVisible();
  await noViolations(page, "the personas");
});

test("the app's own writes pass under the referrer policy", async ({ page, request }) => {
  const writes: Request[] = [];
  page.on("request", (r) => {
    if (["POST", "PUT", "PATCH", "DELETE"].includes(r.method())) writes.push(r);
  });
  const character = await makeCharacter(request);
  made.push(character.id);
  const convo = await makeConversation(request);
  made.push(convo.character_id);
  const persona = `Written ${Date.now()}`;

  const served = await page.goto("/#/personas");
  await page.getByRole("button", { name: "New persona" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill(persona);
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("heading", { name: persona })).toBeVisible();

  await page.goto(`/#/characters/${character.id}/edit`);
  // The field's name holds its hint after the label.
  await page.getByRole("textbox", { name: /^Description / }).fill("Written under the policy.");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#/characters/${character.id}$`));
  expect((await (await request.get(`${API}/api/characters/${character.id}`)).json()).description)
    .toBe("Written under the policy.");

  await page.goto(`/#/chat/${convo.id}`);
  await page.getByPlaceholder(/^Write to Vane/).fill("And then?");
  const ends = replyEnds(page, convo.id);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await ends;
  // By its id: once the editor is open, the words it was found by are no longer shown.
  const id = await page.locator("[data-message-id]", { hasText: "And then?" }).getAttribute("data-message-id");
  const sent = page.locator(`[data-message-id="${id}"]`);
  await sent.getByTitle("Edit").click();
  await sent.locator("textarea").fill("And then, rewritten?");
  await sent.getByRole("button", { name: "Save" }).click();
  await expect(sent.locator("textarea")).toHaveCount(0);
  await expect(sent).toContainText("And then, rewritten?");

  await page.goto("/#/personas");
  await page.getByRole("button", { name: persona }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
  await answer(page, true);
  await expect(page.getByRole("heading", { name: persona })).toHaveCount(0);
  const left = (await (await request.get(`${API}/api/personas`)).json()) as { name: string }[];
  expect(left.map((p) => p.name)).not.toContain(persona);

  const origin = new URL(page.url()).origin;
  for (const write of writes) {
    const what = `${write.method()} ${new URL(write.url()).pathname}`;
    // allHeaders, not headers: the latter leaves out what the network layer adds, Origin among them.
    expect((await write.allHeaders()).origin, `${what} lost its origin`).toBe(origin);
    expect((await write.response())?.ok(), `${what} was refused`).toBe(true);
  }
  expect(new Set(writes.map((w) => w.method()))).toEqual(new Set(["POST", "PUT", "PATCH", "DELETE"]));
  // A return to no-referrer would send Origin: null with every write of a browser that follows the
  // standard to the letter, and the gate refuses that.
  expect(served?.headers()["referrer-policy"]).toBe("same-origin");
});

test("the sign-in page works under the policy", async ({ page }) => {
  await watchPolicy(page);
  await page.goto(`${GATED}/#/login`);
  await page.getByLabel(/password/i).fill(GATE_PASSWORD);
  await page.getByRole("button", { name: /enter/i }).click();
  await expect(page).toHaveURL(`${GATED}/#/`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await noViolations(page, "the sign-in and the home page after it");
});

test("the page asks no name in advance, even served without our headers", async ({ page }) => {
  // No look-up is seen from a test browser: this pins down what stops one.
  const served = await page.goto("/");
  expect(served?.headers()["x-dns-prefetch-control"]).toBe("off");
  // For the page served without our headers (Vite's own server, the Anna edition): read before any script.
  const before = await page.evaluate(() => {
    const meta = document.head.querySelector('meta[http-equiv="x-dns-prefetch-control"][content="off"]');
    const script = document.querySelector("script");
    return !!meta && !!script && !!(meta.compareDocumentPosition(script) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  expect(before, "the tag is missing, or comes after the first script").toBe(true);
});
