import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { API } from "../playwright.config";
import { chat, conversation, makeConversation, replyEnds } from "./fixtures";

/** A Remember or a Condense goes on when its page is left, as a reply does, while another
 *  conversation is answered; coming back shows it running, then what it did. The fake model takes
 *  twelve seconds over a memory request in a conversation that says MOCK_SLOW_MEMORY. */

const MARK = "This conversation's memory could not be updated";

/** A story of five exchanges, under the eight replies that would bring the automatic pass. */
async function slowStory(request: APIRequestContext, also = "") {
  const convo = await makeConversation(request);
  for (let n = 1; n <= 5; n++) {
    const content = `Turn ${n}. MOCK_SLOW_MEMORY ${also}`.trim();
    expect((await chat(request, { conversation_id: convo.id, mode: "send", content })).ok()).toBe(true);
  }
  return convo.id as string;
}

const running = async (request: APIRequestContext, id: string): Promise<boolean> =>
  (await conversation(request, id)).memory_running;

/** The panel of the conversation, opened if the screen is too narrow to open it by itself. */
async function panelOf(page: Page, id: string) {
  await page.goto(`/#/chat/${id}`);
  await expect(page.locator("textarea").first()).toBeVisible();
  const opener = page.locator("header button:has(svg.lucide-sliders-horizontal)");
  if (await opener.isVisible()) await opener.click();
  return page.locator("aside:visible:has(textarea)");
}

/** Away from the conversation: home, then another character's conversation, whose reply is read
 *  while the memory of the first is still being worked on. */
async function elsewhere(page: Page, request: APIRequestContext, id: string) {
  await page.goto("/#/");
  await expect(page.locator("main h1")).toBeVisible();
  const other = await makeConversation(request, { name: `Other ${Date.now()}` });
  await page.goto(`/#/chat/${other.id}`);
  await page.locator("textarea").first().fill("Hello there.");
  const ends = replyEnds(page, other.id);
  await page.getByTitle("Send", { exact: true }).click();
  await ends;
  await expect(page.locator("[data-message-id]")).toHaveCount(3);
  expect(await running(request, id), "the first conversation's memory is no longer being worked on").toBe(true);
}

for (const { name, button, before, after } of [
  {
    name: "Remember",
    button: "Remember",
    before: async () => {},
    after: "Turn 5 happened (MOCK_SLOW_MEMORY).",
  },
  {
    name: "Condense",
    button: "Condense",
    // Ten facts, one a turn, enough to merge.
    before: async (request: APIRequestContext, id: string) => {
      expect((await request.post(`${API}/api/conversations/${id}/memories/extract`)).ok()).toBe(true);
    },
    after: "The whole story so far, in one line.",
  },
]) {
  test(`a ${name} goes on while its page is left and another conversation is answered`, { tag: "@desktop" }, async ({ page, request }) => {
    const id = await slowStory(request);
    await before(request, id);
    let panel = await panelOf(page, id);
    await panel.getByRole("button", { name: button, exact: true }).click();
    await expect.poll(() => running(request, id)).toBe(true);

    await elsewhere(page, request, id);

    panel = await panelOf(page, id);
    const asked = panel.getByRole("button", { name: button, exact: true });
    // Found running: as if asked from here, both buttons waiting.
    await expect(asked).toBeDisabled();
    await expect(asked.locator(".animate-spin")).toBeVisible();
    await expect(panel.getByRole("button", { name: button === "Remember" ? "Condense" : "Remember", exact: true })).toBeDisabled();
    // Then done, and what it did is there.
    await expect(asked).toBeEnabled({ timeout: 20_000 });
    // Not exact: a fact is drawn with the turn it was drawn from.
    await expect(panel.getByText(after)).toBeVisible();
    await expect(panel.locator("p.text-blood")).toHaveCount(0);
    expect(await running(request, id)).toBe(false);
  });
}

test("a Remember that fails after its page was left is told on the header and in the panel", { tag: "@desktop" }, async ({ page, request }) => {
  const id = await slowStory(request, "MOCK_FORGETS");
  let panel = await panelOf(page, id);
  await panel.getByRole("button", { name: "Remember", exact: true }).click();
  await expect.poll(() => running(request, id)).toBe(true);
  await page.goto("/#/");
  await expect(page.locator("main h1")).toBeVisible();
  await expect.poll(async () => (await conversation(request, id)).memory_error?.error ?? null, { timeout: 20_000 })
    .toBe("The mock was told to forget.");

  await page.goto(`/#/chat/${id}`);
  await expect(page.locator("textarea").first()).toBeVisible();
  const close = page.getByRole("button", { name: "Close panel" });
  if (await close.isVisible()) await close.click();
  await expect(page.getByRole("img", { name: MARK })).toBeVisible();

  panel = await panelOf(page, id);
  await expect(panel.locator("p.text-blood")).toHaveText("The model reported an error: The mock was told to forget.");
  await expect(panel.getByRole("button", { name: "Try again", exact: true })).toBeEnabled();
});

test("two conversations are answered at the same time", { tag: "@desktop" }, async ({ request }) => {
  const [first, second] = [await makeConversation(request), await makeConversation(request)];
  for (const id of [first.id, second.id]) {
    await request.patch(`${API}/api/conversations/${id}`, { data: { author_note: "SLOWLY" } });
  }
  const turn = async (id: string) => (await request.get(`${API}/api/conversations/${id}/turn`)).json();
  const ask = (id: string) => request.post(`${API}/api/chat`, {
    data: { conversation_id: id, mode: "send", content: "Go on.", message_mode: "say" },
  });

  expect((await ask(first.id)).ok()).toBe(true);
  expect((await ask(second.id)).ok()).toBe(true);
  // The second reply has words before the first has ended: it did not wait for it.
  await expect.poll(async () => (await turn(second.id)).text ?? "", { timeout: 20_000 }).not.toBe("");
  expect((await turn(first.id)).running, "the first reply ended before the second began").toBe(true);

  for (const id of [first.id, second.id]) {
    await expect.poll(async () => (await turn(id)).running, { timeout: 60_000 }).toBe(false);
    const { messages } = await conversation(request, id);
    expect(messages.at(-1).role).toBe("assistant");
    expect(messages.at(-1).variants[0].length).toBeGreaterThan(0);
  }
});
