import { expect, type APIRequestContext, type Page, type Route } from "@playwright/test";
import { crc32 } from "node:zlib";
import { API } from "../playwright.config";

export const MOCK = `http://127.0.0.1:${process.env.E2E_MOCK_PORT ?? 5699}/v1`;

/** Seeding goes through the API, never the interface. A test that had to click
 *  its way to a conversation would fail for reasons that have nothing to do
 *  with what it is checking. */

/** An AI on its service, made as the page adds one; `changes` are then saved on it (an AI's own
 *  fields, such as `reply_cap`). A model already on that service is the AI already there. */
export async function addModel(
  request: APIRequestContext,
  { base_url, model, api_key = "none", name, changes }:
    { base_url: string; model: string; api_key?: string; name?: string; changes?: Record<string, unknown> },
): Promise<{ id: string; name: string }> {
  const made = await (await request.post(`${API}/api/models`, {
    data: { service: { provider: "openai-compatible", base_url, api_key }, models: [{ model, name }] },
  })).json();
  const ai = made.models[0];
  if (changes) await request.put(`${API}/api/models/${ai.id}`, { data: changes });
  return ai;
}

/** The mock server's own address, under which its paths choose an answer (/many/, /broken/…). */
export const MOCK_ROOT = MOCK.replace(/\/v1$/, "");

/** Sends what the page asks of a real service's address to another one: the chips name the real
 *  addresses, which nothing here may call. The page still sends the chip's family, so that
 *  OpenRouter's key check and prices are read as OpenRouter's. Only the probe and the add. */
export async function routeServiceTo(page: Page, from: string, to: string): Promise<void> {
  const moved = async (route: Route) => {
    const body = route.request().postDataJSON() as Record<string, unknown> | null;
    const service = (body && "service" in body ? body.service : body) as { base_url?: string } | null;
    if (service && typeof service.base_url === "string") service.base_url = service.base_url.replace(from, to);
    await route.continue({ postData: body === null ? undefined : JSON.stringify(body) });
  };
  await page.route("**/api/connections/probe", moved);
  await page.route("**/api/models", (route) => (route.request().method() === "POST" ? moved(route) : route.continue()));
}

/** Takes away, through the API, every AI whose service's address holds `fragment`; its service goes
 *  with the last of them. A service left with none is taken away too. The suite's server is shared
 *  between tests and a retry: a test that counts begins with this. */
export async function forgetServices(request: APIRequestContext, fragment: string): Promise<void> {
  const ais = await (await request.get(`${API}/api/models`)).json();
  for (const ai of ais as { id: string; service: { base_url: string } }[]) {
    if (ai.service.base_url.includes(fragment)) await request.delete(`${API}/api/models/${ai.id}`);
  }
  const services = await (await request.get(`${API}/api/connections`)).json();
  for (const service of services as { id: string; base_url: string; model_count: number }[]) {
    if (service.base_url.includes(fragment) && service.model_count === 0) {
      await request.delete(`${API}/api/connections/${service.id}`);
    }
  }
}

async function defaultModel(request: APIRequestContext): Promise<string> {
  const existing = await (await request.get(`${API}/api/models`)).json();
  const found = existing.find((ai: { name: string }) => ai.name === "e2e");
  if (!found) {
    const ai = await addModel(request, { base_url: MOCK, model: "evermind-demo", name: "e2e" });
    await request.put(`${API}/api/models/${ai.id}`, { data: { is_default: true } });
    return ai.id;
  }
  if (!found.is_default) {
    await request.put(`${API}/api/models/${found.id}`, { data: { is_default: true } });
  }
  return found.id;
}

export async function makeCharacter(request: APIRequestContext, fields: Record<string, unknown> = {}) {
  await defaultModel(request);
  return (await request.post(`${API}/api/characters`, {
    data: {
      name: "Vane",
      kind: "character",
      tagline: "Made for a test",
      description: "Terse. Does not repeat herself.",
      greeting: "The door was already open.",
      ...fields,
    },
  })).json();
}

export async function makeConversation(request: APIRequestContext, fields: Record<string, unknown> = {}) {
  const character = await makeCharacter(request, fields);
  return (await request.post(`${API}/api/conversations`, {
    data: { character_id: character.id },
  })).json();
}

/** A conversation with one exchange already in it. `slowly` puts a marker in it that the mock model
 *  answers at a crawl: a test about what happens during a reply needs one still going when it looks,
 *  and sleeps tuned to one machine fail on another. */
export async function conversationWithReply(
  request: APIRequestContext,
  { slowly = false, failing = false, failsMidway = false, silent = false, quiet = false, says }: {
    slowly?: boolean;
    failing?: boolean;
    /** The model writes four words and the connection to it breaks. */
    failsMidway?: boolean;
    /** The model ends its reply without a word. */
    silent?: boolean;
    /** The model takes eight seconds over its first word. */
    quiet?: boolean;
    /** The reply is this word, then numbers, then "end" and this word. */
    says?: string;
  } = {},
) {
  const convo = await makeConversation(request);
  await chat(request, { conversation_id: convo.id, mode: "send", content: "Tell me." });
  // After the first reply, not before: the markers are for the turn the test is
  // about, and putting them in the message would make setting up slow too.
  const markers = [
    slowly && "SLOWLY",
    failing && "MOCK_FAILS", // a model that refuses a couple of seconds into a turn
    failsMidway && "MOCK_FAILS_MIDWAY",
    silent && "MOCK_SILENT",
    quiet && "MOCK_QUIET",
    says && `MOCK_SAYS_${says}`,
  ].filter(Boolean);
  if (markers.length) {
    await request.patch(`${API}/api/conversations/${convo.id}`, {
      data: { author_note: markers.join(" ") },
    });
  }
  return (await request.get(`${API}/api/conversations/${convo.id}`)).json();
}

export async function conversation(request: APIRequestContext, id: string) {
  return (await request.get(`${API}/api/conversations/${id}`)).json();
}

/** Whether an address reads the conversation, with its messages or without, as the side panel does. */
export const readOf = (id: string) => (url: string | URL) =>
  new URL(url).pathname.endsWith(`/api/conversations/${id}`);

/** The server's own account of whether a reply is being written. */
export async function turnRunning(request: APIRequestContext, id: string): Promise<boolean> {
  return (await (await request.get(`${API}/api/conversations/${id}/turn`)).json()).running;
}

/** Settles once the page has heard that the reply it asked for has ended: the server's answer to
 *  the request, then its word, read by the page, that nothing is being written any more. What the
 *  page does at a reply's end is looked for from there, not from the click: how long the reply
 *  takes is the model's and the machine's. Called before the click. */
export function replyEnds(page: Page, id: string): Promise<unknown> {
  let asked = false;
  return page.waitForResponse(async (r) => {
    const method = r.request().method();
    const where = new URL(r.url()).pathname;
    if (method === "POST" && where.endsWith("/api/chat")) asked = true;
    else if (asked && method === "GET" && where.endsWith(`/api/conversations/${id}/turn`)) {
      // A read the page gave up on brings no word.
      return (await r.json().catch(() => ({ running: true }))).running === false;
    }
    return false;
  });
}

/** Settles once the page has heard that the card it follows has ended: the server's word, read by
 *  the page, that the job no longer runs, or the answer to its Stop. What the form shows at a card's
 *  end is looked for from there: how long the card takes is the model's and the machine's. Called
 *  before what begins the job. */
export function cardEnds(page: Page): Promise<unknown> {
  return page.waitForResponse(async (r) => {
    const method = r.request().method();
    if (method !== "GET" && method !== "DELETE") return false;
    if (!/\/api\/characters\/assist\/[^/]+$/.test(new URL(r.url()).pathname)) return false;
    // A read the page gave up on brings no word.
    return (await r.json().catch(() => ({ running: true }))).running === false;
  });
}

/** Settles once the server has answered the page's Remember, which is when the panel shows what it wrote. */
export const remembered = (page: Page) =>
  page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith("/memories/extract"));

/** A turn asked for as another device would, and its reply written: the server answers as soon
 *  as it has the message. */
export async function chat(request: APIRequestContext, data: { conversation_id: string } & Record<string, unknown>) {
  const answer = await request.post(`${API}/api/chat`, { data: { message_mode: "say", ...data } });
  await expect.poll(() => turnRunning(request, data.conversation_id), { timeout: 60_000 }).toBe(false);
  return answer;
}

/** Ends a reply and waits for the server to say it has ended. A turn carries on
 *  with nobody watching, so a slow one left behind would go on writing into the
 *  tests that come next. Only for a turn the server already has: a stop that
 *  overtakes the request starting it stops nothing. */
export async function stopTurn(request: APIRequestContext, id: string) {
  await request.delete(`${API}/api/conversations/${id}/turn`);
  await expect.poll(() => turnRunning(request, id), {
    message: "the reply kept being written after it was stopped",
    timeout: 10_000,
  }).toBe(false);
}

/** What the page has thrown, by page: an error is a failure of the policy's test as much as a violation. */
const thrown = new WeakMap<Page, string[]>();

/** Keeps, from the next page the tab opens, each breach of the security policy as
 *  `${violatedDirective} ${blockedURI}` in `window.__violations`, and each error the page throws.
 *  Called before the first `goto`. */
export async function watchPolicy(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const kept: string[] = [];
    (window as unknown as { __violations: string[] }).__violations = kept;
    document.addEventListener("securitypolicyviolation", (event) => {
      kept.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
  const errors: string[] = [];
  thrown.set(page, errors);
  page.on("pageerror", (error) => errors.push(`pageerror ${error.message}`));
}

/** The breaches the current document has seen, and the errors every page of the tab has thrown. */
export async function policyViolations(page: Page): Promise<string[]> {
  const seen = await page.evaluate(() => (window as unknown as { __violations?: string[] }).__violations ?? []);
  return [...seen, ...(thrown.get(page) ?? [])];
}

/** A tiny PNG, for anything that needs a file to upload. */
export const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** The tiny PNG carrying a card in a tEXt chunk named `chara`, before its end, as an old import found one. */
export function cardPortrait(card: unknown) {
  const body = Buffer.from(`tEXtchara\0${Buffer.from(JSON.stringify(card)).toString("base64")}`, "latin1");
  const chunk = Buffer.alloc(body.length + 8);
  chunk.writeUInt32BE(body.length - 4, 0);
  body.copy(chunk, 4);
  chunk.writeUInt32BE(crc32(body), body.length + 4);
  return Buffer.concat([PNG.subarray(0, -12), chunk, PNG.subarray(-12)]);
}

/** Settles once the confirmation box a click has just opened hears its button that confirms. The
 *  box is deaf to it for half a second from the frame that draws it (DEAF_MS in Confirm.tsx), when
 *  the second press of a double tap would land there. The wait begins once a frame has passed since
 *  the box was in the page, so that one has drawn it: a slow machine only makes this longer. */
export async function boxHears(page: Page): Promise<void> {
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await page.evaluate(() => new Promise((framed) => requestAnimationFrame(() => requestAnimationFrame(framed))));
  await page.waitForTimeout(600);
}

/** Answers the confirmation box a click has just opened: the button that confirms (the last one) or
 *  Cancel, and waits for the box to close. */
export async function answer(page: Page, accept: boolean): Promise<void> {
  const box = page.getByRole("alertdialog");
  const buttons = box.getByRole("button");
  if (accept) await boxHears(page);
  // The cross is a button too, ahead of the two answers; the answer that confirms comes last.
  await (accept ? buttons.last() : box.getByRole("button", { name: "Cancel" })).click();
  await expect(box).toHaveCount(0);
}

/** A root size of the page's own, as Safari and Firefox set it for very large system text: given to
 *  `page.addInitScript` before the first `goto`, with "32px" (as display.spec.ts sets it). */
export function rootAt(size: string) {
  const set = () => document.documentElement.style.setProperty("font-size", size);
  if (document.documentElement) set();
  else document.addEventListener("DOMContentLoaded", set);
}

/** The language of every page the tab opens from the next one: given before the first `goto`. */
export async function inLocale(page: Page, locale: string): Promise<void> {
  await page.addInitScript((chosen) => localStorage.setItem("evermind:locale", chosen), locale);
}

/** What does not fit a phone, within the element `within` selects (the page by default): the page
 *  sliding sideways, a control past the screen's edges or wider than its own box, a select wider
 *  than the box it sits in, a word of a control's label broken in the middle. Each said in a line. */
export async function misfits(page: Page, within = "body"): Promise<string[]> {
  // Measured in the page's own fonts: a fallback font has other widths.
  await page.evaluate(() => document.fonts.ready);
  return page.evaluate((selector) => {
    const found: string[] = [];
    const root = document.documentElement;
    const width = root.clientWidth;
    if (root.scrollWidth > width) found.push(`the page slides ${root.scrollWidth - width}px`);
    const main = document.querySelector("main");
    if (main && main.scrollWidth > main.clientWidth) found.push(`<main> slides ${main.scrollWidth - main.clientWidth}px`);
    const scope = document.querySelector(selector) ?? document.body;
    for (const el of scope.querySelectorAll<HTMLElement>("button, a.btn, select, [role=button]")) {
      const box = el.getBoundingClientRect();
      if (box.width === 0 || getComputedStyle(el).visibility === "hidden") continue;
      const name = (el.textContent?.trim() || el.getAttribute("aria-label") || el.tagName).slice(0, 40);
      // A rail of chips scrolls sideways on purpose.
      if (!el.closest(".overflow-x-auto") && (box.right > width + 0.5 || box.left < -0.5)) {
        found.push(`"${name}" at ${Math.round(box.left)}..${Math.round(box.right)} of ${width}`);
      }
      if (el.tagName === "SELECT") {
        const room = el.parentElement!.getBoundingClientRect();
        if (box.right > room.right + 0.5) found.push(`select "${name}" ${Math.round(box.width)} wide in ${Math.round(room.width)}`);
        continue;
      }
      if (el.scrollWidth > el.clientWidth + 1) found.push(`"${name}" ${el.scrollWidth} wide in ${el.clientWidth}`);
      const texts = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let node = texts.nextNode(); node; node = texts.nextNode()) {
        // An address or a key's end in the control, set to break anywhere on purpose.
        if (node.parentElement !== el && getComputedStyle(node.parentElement!).overflowWrap === "anywhere") continue;
        for (const word of (node.textContent ?? "").matchAll(/\S+/g)) {
          const range = document.createRange();
          range.setStart(node, word.index);
          range.setEnd(node, word.index + word[0].length);
          const lines = new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top)));
          // Unless the word alone is wider than the control can hold.
          const style = getComputedStyle(el);
          const room = el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
          const long = [...range.getClientRects()].reduce((sum, r) => sum + r.width, 0);
          if (lines.size > 1 && long <= room) found.push(`"${word[0]}" broken in the middle in "${name}"`);
        }
      }
    }
    return found;
  }, within);
}
