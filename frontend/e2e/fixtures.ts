import type { APIRequestContext } from "@playwright/test";
import { API } from "../playwright.config";

const MOCK = "http://127.0.0.1:5699/v1";

/** Seeding goes through the API, never the interface. A test that had to click
 *  its way to a conversation would fail for reasons that have nothing to do
 *  with what it is checking. */

async function defaultConnection(request: APIRequestContext): Promise<string> {
  const existing = await (await request.get(`${API}/api/connections`)).json();
  const found = existing.find((c: { name: string }) => c.name === "e2e");
  const id = found?.id ?? (await (await request.post(`${API}/api/connections`, {
    data: {
      name: "e2e", provider: "openai-compatible", base_url: MOCK,
      api_key: "none", model: "evermind-demo",
    },
  })).json()).id;
  await request.put(`${API}/api/settings`, { data: { default_connection_id: id } });
  return id;
}

export async function makeCharacter(request: APIRequestContext, fields: Record<string, unknown> = {}) {
  await defaultConnection(request);
  return (await request.post(`${API}/api/characters`, {
    data: {
      name: "Vane",
      kind: "character",
      tagline: "Made for a test",
      description: "Terse. Does not repeat herself.",
      first_message: "The door was already open.",
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

/** A conversation with one exchange already in it, so a test that needs a
 *  reply to act on does not have to wait for the model twice. */
export async function conversationWithReply(request: APIRequestContext) {
  const convo = await makeConversation(request);
  await request.post(`${API}/api/chat`, {
    data: { conversation_id: convo.id, mode: "send", content: "Tell me.", message_mode: "say" },
    timeout: 60_000,
  });
  return (await request.get(`${API}/api/conversations/${convo.id}`)).json();
}

export async function conversation(request: APIRequestContext, id: string) {
  return (await request.get(`${API}/api/conversations/${id}`)).json();
}

/** A tiny PNG, for anything that needs a file to upload. */
export const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
