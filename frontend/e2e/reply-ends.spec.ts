import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { API } from "../playwright.config";
import { conversationWithReply, MOCK, replyEnds } from "./fixtures";

/**
 * A reply that ends without what was asked for says why, as a person on a phone reads it
 * (see scripts/mock_llm.py): a model that reasoned through all its room and wrote nothing, a
 * server that withheld the answer and said so, and a reply cut a few words in by the connection's
 * max tokens, which Continue carries on.
 */

test.use({ viewport: { width: 390, height: 844 } });

/** A conversation with one exchange in it, its model now told to end the next reply `how`. */
async function endingWith(request: APIRequestContext, how: string, connection: Record<string, unknown> = {}) {
  const convo = await conversationWithReply(request);
  const patch: Record<string, unknown> = { author_note: how };
  if (Object.keys(connection).length) {
    const own = await (await request.post(`${API}/api/connections`, {
      data: {
        name: `reply-ends ${Date.now()}`, provider: "openai-compatible", base_url: MOCK,
        api_key: "none", model: "evermind-demo", ...connection,
      },
    })).json();
    patch.connection_id = own.id;
  }
  await request.patch(`${API}/api/conversations/${convo.id}`, { data: patch });
  return convo;
}

async function sendFromTheBox(page: Page, id: string) {
  await page.goto(`/#/chat/${id}`);
  await page.locator("textarea").first().fill("What now?");
  const ends = replyEnds(page, id);
  await page.locator('button[title="Send"]').click();
  await ends;
}

async function noSidewaysScroll(page: Page) {
  const wider = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(wider, "the page scrolls sideways").toBeLessThanOrEqual(0);
}

test("a model that only reasoned says so, with what to change", { tag: "@desktop" }, async ({ page, request }) => {
  const convo = await endingWith(request, "MOCK_REASONS_ONLY");
  await sendFromTheBox(page, convo.id);

  const said = page.getByRole("alert");
  await expect(said).toHaveText(
    "The model spent its whole answer thinking and wrote nothing. Raise the connection's max tokens, or use a model that does not think as long.",
  );
  await expect(page.getByText("The model returned an empty reply.")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  await noSidewaysScroll(page);
});

test("an answer its server withheld quotes the server's word", { tag: "@desktop" }, async ({ page, request }) => {
  const convo = await endingWith(request, "MOCK_WITHHOLDS");
  await sendFromTheBox(page, convo.id);

  await expect(page.getByRole("alert")).toHaveText(
    'The model\'s server withheld the answer ("content_filter"). Try again, or change the model or the provider.',
  );
  await noSidewaysScroll(page);
});

test("a reply cut by the max tokens says why under it, and Continue carries it to its end", { tag: "@desktop" }, async ({ page, request }) => {
  const convo = await endingWith(request, "MOCK_HITS_CEILING", { max_tokens: 1024 });
  await sendFromTheBox(page, convo.id);

  const reply = page.locator("[data-message-id]").last();
  const line = reply.locator("[data-ceiling]");
  await expect(line).toHaveText(
    "Cut short: this reply reached the connection's limit of 1,024 tokens, and the model's thinking counts toward it. Continue the reply to carry on.",
  );
  // Said once as the reply comes in, with the reply; not a failure, and not "interrupted".
  await expect(page.getByRole("status")).toContainText("reached the connection's limit of 1,024 tokens");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(reply).not.toContainText("interrupted");
  await noSidewaysScroll(page);
  const before = (await reply.locator(".min-w-0 > .mt-1").innerText()).trim();

  // The model has room again: Continue ends the reply as a reply ends.
  await request.patch(`${API}/api/conversations/${convo.id}`, { data: { author_note: "" } });
  await page.waitForLoadState("networkidle");
  const ends = replyEnds(page, convo.id);
  await reply.locator('button[title="Continue the reply"]').click({ force: true });
  await ends;

  await expect(line).toHaveCount(0);
  await expect(reply.locator(".min-w-0 > .mt-1")).toContainText(before);
  expect((await reply.locator(".min-w-0 > .mt-1").innerText()).trim().length).toBeGreaterThan(before.length);
  const read = await (await request.get(`${API}/api/conversations/${convo.id}`)).json();
  expect(read.messages.at(-1).meta.ceiling).toBeUndefined();
  await noSidewaysScroll(page);
});
