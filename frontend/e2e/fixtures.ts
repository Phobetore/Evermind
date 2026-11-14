import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { crc32 } from "node:zlib";
import { API } from "../playwright.config";

export const MOCK = `http://127.0.0.1:${process.env.E2E_MOCK_PORT ?? 5699}/v1`;

/** Seeding goes through the API, never the interface. A test that had to click
 *  its way to a conversation would fail for reasons that have nothing to do
 *  with what it is checking. */

async function defaultConnection(request: APIRequestContext): Promise<string> {
  const existing = await (await request.get(`${API}/api/connections`)).json();
  const found = existing.find((c: { name: string }) => c.name === "e2e");
  if (!found) {
    return (await (await request.post(`${API}/api/connections`, {
      data: {
        name: "e2e", provider: "openai-compatible", base_url: MOCK,
        api_key: "none", model: "evermind-demo", is_default: true,
      },
    })).json()).id;
  }
  if (!found.is_default) {
    await request.put(`${API}/api/connections/${found.id}`, { data: { ...found, is_default: true } });
  }
  return found.id;
}

export async function makeCharacter(request: APIRequestContext, fields: Record<string, unknown> = {}) {
  await defaultConnection(request);
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
