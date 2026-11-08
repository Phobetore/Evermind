import { expect, type APIRequestContext } from "@playwright/test";
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
