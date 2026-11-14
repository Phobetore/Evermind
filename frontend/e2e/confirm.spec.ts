import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { API } from "../playwright.config";
import { answer, boxHears, chat, conversation, conversationWithReply, makeConversation } from "./fixtures";

/** What cannot be taken back is asked about in a box of our own: the browser's `confirm()` is not
 *  there to answer in a frame that forbids modals. */

async function listed(page: Page, request: APIRequestContext) {
  const convo = await makeConversation(request);
  const title = `Asked ${Date.now()}`;
  await request.patch(`${API}/api/conversations/${convo.id}`, { data: { title } });
  await page.goto("/#/chat");
  const row = page.locator(`main a[href$="/chat/${convo.id}"]`);
  await expect(row).toContainText(title);
  return { id: convo.id as string, row, remove: row.getByRole("button", { name: "Delete" }) };
}

const box = (page: Page) => page.getByRole("alertdialog", { name: /Delete the conversation/ });

test("asked before a conversation is deleted, and Cancel keeps it", async ({ page, request }) => {
  const { row, remove } = await listed(page, request);
  await remove.click();
  await expect(box(page)).toBeVisible();

  await answer(page, false);
  await expect(row).toBeVisible();
});

test("Escape keeps it and hands the focus back", { tag: "@desktop" }, async ({ page, request }) => {
  const { row, remove } = await listed(page, request);
  await remove.click();
  await expect(box(page)).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(row).toBeVisible();
  await expect(remove).toBeFocused();
});

test("Enter as it opens deletes nothing", { tag: "@desktop" }, async ({ page, request }) => {
  const { row, remove } = await listed(page, request);
  await remove.click();
  await expect(box(page).getByRole("button", { name: "Cancel" })).toBeFocused();

  await page.keyboard.press("Enter");
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(row).toBeVisible();
});

test("a yes from the keyboard is heard at once", { tag: "@desktop" }, async ({ page, request }) => {
  const { id, row, remove } = await listed(page, request);
  const deletes: string[] = [];
  page.on("request", (r) => r.method() === "DELETE" && deletes.push(r.url()));
  await remove.focus();
  await page.keyboard.press("Enter");
  await expect(box(page).getByRole("button", { name: "Cancel" })).toBeFocused();

  // No wait for the box to hear: the half second guards a pointer's second press, and from the
  // keyboard the focus on Cancel is the guard. Tab and Enter back to back, as a hand that knows
  // the box presses them.
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(row).toHaveCount(0);
  expect(deletes.filter((url) => url.endsWith(`/api/conversations/${id}`))).toHaveLength(1);
});

test("confirming deletes it, once", async ({ page, request }) => {
  const { id, row, remove } = await listed(page, request);
  const deletes: string[] = [];
  page.on("request", (r) => r.method() === "DELETE" && deletes.push(r.url()));

  await remove.click();
  await boxHears(page);
  // Two clicks in one task on the button that confirms, before the box can close: the second must
  // not send a second request. (A real second tap would land on the row underneath.)
  await box(page).getByRole("button", { name: "Delete", exact: true }).evaluate((b: HTMLElement) => { b.click(); b.click(); });
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(row).toHaveCount(0);

  expect(deletes.filter((url) => url.endsWith(`/api/conversations/${id}`))).toHaveLength(1);
});

test("both buttons can be hit on a phone", async ({ page, request }) => {
  const { remove } = await listed(page, request);
  await remove.click();

  for (const name of ["Cancel", "Delete"]) {
    const button = box(page).getByRole("button", { name, exact: true });
    expect((await button.boundingBox())!.height, `${name} is too small to hit`).toBeGreaterThanOrEqual(43.5);
  }
});

test("a confirmation over another dialog answers for itself", async ({ page, request }) => {
  const persona = await (await request.post(`${API}/api/personas`, { data: { name: `Asked ${Date.now()}` } })).json();
  await page.goto("/#/personas");
  await page.getByRole("button", { name: persona.name }).click();
  const window = page.getByRole("dialog");
  await window.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("alertdialog")).toBeVisible();

  await answer(page, false);
  await expect(window).toBeVisible();
  await expect(window.getByRole("button", { name: "Delete" })).toBeFocused();
  const kept = (await (await request.get(`${API}/api/personas`)).json()).filter((p: { id: string }) => p.id === persona.id);
  expect(kept).toHaveLength(1);
  await request.delete(`${API}/api/personas/${persona.id}`);
});

test("a second question while one is open is a no, and the first still answers", async ({ page, request }) => {
  const first = await listed(page, request);
  const other = await makeConversation(request);
  const title = `Asked other ${Date.now()}`;
  await request.patch(`${API}/api/conversations/${other.id}`, { data: { title } });
  await page.reload();
  const second = page.locator(`main a[href$="/chat/${other.id}"]`);
  await expect(second).toContainText(title);

  // Both in one task, as two taps in the same frame: the first question must not be replaced.
  await page.evaluate(([a, b]) => {
    for (const id of [a, b]) {
      document.querySelector<HTMLButtonElement>(`main a[href$="/chat/${id}"] button[aria-label="Delete"], main a[href$="/chat/${id}"] button[title="Delete"]`)?.click();
    }
  }, [first.id, other.id]);
  await expect(page.getByRole("alertdialog")).toHaveCount(1);

  await answer(page, true);
  await expect(first.row).toHaveCount(0);
  await expect(second).toBeVisible();
  await request.delete(`${API}/api/conversations/${other.id}`);
});

test("a question is dropped when the page it was about is left", async ({ page, request }) => {
  const { row, remove } = await listed(page, request);
  await remove.click();
  await expect(box(page)).toBeVisible();

  await page.evaluate(() => { location.hash = "#/personas"; });
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await page.goBack();
  await expect(row).toBeVisible();
});

test("Delete from here and Branch stay enabled while asked, and a No gives the focus back", { tag: "@desktop" }, async ({ page, request }) => {
  const convo = await conversationWithReply(request);
  const reply = page.locator(`[data-message-id="${convo.messages.at(-1).id}"]`);
  await page.goto(`/#/chat/${convo.id}`);
  await expect(reply).toBeVisible();

  for (const title of ["Delete from here", "Branch the story from here"]) {
    const opener = reply.getByTitle(title);
    await opener.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("alertdialog")).toBeVisible();
    await expect(opener, "nobody has agreed to it yet").toBeEnabled();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await expect(opener).toBeFocused();
  }
});

/** The box opens under the pointer, and on some screens its button that confirms comes up where the
 *  button that opened it was: the second press of a double tap or a double click falls on it before
 *  anyone has read the question. */

type Rect = { x: number; y: number; width: number; height: number };
type Press = { inBox: boolean; on: string };

/** Each click the page hears from here on: the button it fell on, and whether that one is in the box. */
async function clicksHeard(page: Page): Promise<() => Promise<Press[]>> {
  await page.evaluate(() => {
    const heard: { inBox: boolean; on: string }[] = [];
    Object.assign(window, { clicksHeard: heard });
    document.addEventListener("click", (event) => {
      const button = (event.target as Element).closest("button");
      heard.push({
        inBox: !!button?.closest('[role="alertdialog"]'),
        on: button?.title || button?.getAttribute("aria-label") || button?.textContent || "",
      });
    }, true);
  });
  return () => page.evaluate(() => (window as unknown as { clicksHeard: Press[] }).clicksHeard);
}

/** Presses as a finger or a mouse does, each sent the moment it is asked for, whatever the page is
 *  doing: the browser stamps a press with when it came, as it does a hand's, and the page reads that
 *  stamp, however late it gets round to the press. Each call settles once the page has had it. */
async function presses(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  return {
    tap: (at: { x: number; y: number }) => Promise.all([
      cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [at] }),
      cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }),
    ]),
    click: (at: { x: number; y: number }, clickCount: number) => Promise.all([
      cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...at, button: "left", clickCount }),
      cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...at, button: "left", clickCount }),
    ]),
  };
}

/** The box is drawn where it stays, not rising to it: where its button was measured is where a
 *  press finds it, however soon after it opened. */
const boxStaysPut = (page: Page) => page.emulateMedia({ reducedMotion: "reduce" });

/** A point on both the button that opens the box and, once it is open, the one that confirms. */
function onBoth(opener: Rect, confirms: Rect) {
  const left = Math.max(opener.x, confirms.x);
  const right = Math.min(opener.x + opener.width, confirms.x + confirms.width);
  const top = Math.max(opener.y, confirms.y);
  const bottom = Math.min(opener.y + opener.height, confirms.y + confirms.height);
  expect(Math.min(right - left, bottom - top), "the button that opens the box is not under the one that confirms")
    .toBeGreaterThan(4);
  return { x: (left + right) / 2, y: (top + bottom) / 2 };
}

/** Conversations listed, and one of them scrolled to where its Delete lies under the button that
 *  confirms once the box is open. */
async function rowUnderTheYes(page: Page, request: APIRequestContext) {
  // Rows enough for one of them to be scrolled to where the box's button comes up.
  const stamp = Date.now();
  const ids: string[] = [];
  for (let n = 0; n < 10; n++) {
    const convo = await makeConversation(request);
    await request.patch(`${API}/api/conversations/${convo.id}`, { data: { title: `Asked ${stamp} ${n}` } });
    ids.push(convo.id);
  }
  await boxStaysPut(page);
  await page.goto("/#/chat");
  const rows = page.locator('main a[href*="/chat/"]').filter({ hasText: `Asked ${stamp}` });
  await expect(rows).toHaveCount(ids.length);

  // Where the button that confirms comes up: the same for each of these rows, titled alike.
  await rows.first().getByRole("button", { name: "Delete" }).click();
  const confirms = (await box(page).getByRole("button", { name: "Delete", exact: true }).boundingBox())!;
  await answer(page, false);
  const height = confirms.y + confirms.height / 2;

  // The first row lying lower is scrolled up to there.
  const lower = await rows.evaluateAll((all, y) => all.findIndex((row) => {
    const remove = row.querySelector('button[aria-label="Delete"]')!.getBoundingClientRect();
    return remove.top + remove.height / 2 >= y;
  }), height);
  expect(lower, "no row lies as low as the button that confirms").toBeGreaterThanOrEqual(0);
  const id = (await rows.nth(lower).getAttribute("href"))!.split("/").pop()!;
  const row = page.locator(`main a[href$="/chat/${id}"]`);
  const remove = row.getByRole("button", { name: "Delete" });
  const before = (await remove.boundingBox())!;
  await page.locator("main").evaluate((main, by) => { main.scrollTop += by; }, before.y + before.height / 2 - height);
  const point = onBoth((await remove.boundingBox())!, confirms);

  const deletes: string[] = [];
  page.on("request", (r) => r.method() === "DELETE" && deletes.push(r.url()));
  return {
    id, row, point, deletes,
    /** Once there has been time to read it, the same button is heard. */
    async heardOnceRead(tap: (at: { x: number; y: number }) => Promise<unknown>) {
      await boxHears(page);
      await tap(point);
      await expect(page.getByRole("alertdialog")).toHaveCount(0);
      await expect(row).toHaveCount(0);
      expect(deletes.filter((url) => url.endsWith(`/api/conversations/${id}`))).toHaveLength(1);
      for (const other of ids.filter((seeded) => seeded !== id)) await request.delete(`${API}/api/conversations/${other}`);
    },
  };
}

test("the second tap of a double tap on a row's Delete lands on the button that confirms, and deletes nothing", async ({ page, request }) => {
  const { point, deletes, heardOnceRead } = await rowUnderTheYes(page, request);
  const clicks = await clicksHeard(page);
  const press = await presses(page);
  // Back to back, neither waiting for the page: however slow this machine, the two are as close
  // as a hand's.
  await Promise.all([press.tap(point), press.tap(point)]);
  await expect.poll(clicks).toEqual([{ inBox: false, on: "Delete" }, { inBox: true, on: "Delete" }]);
  await expect(box(page), "a yes to a question nobody had the time to read").toBeVisible();
  expect(deletes).toHaveLength(0);

  await heardOnceRead(press.tap);
});

test("a tap made before a busy page has drawn the box is no yes, however late the page hears it", async ({ page, request }) => {
  const { point, deletes, heardOnceRead } = await rowUnderTheYes(page, request);
  // The page is held up for longer than the box stays deaf, as it opens: as a slow phone with a
  // long list is, where the box comes up a second after the press that opened it.
  await page.evaluate(() => {
    const watching = new MutationObserver(() => {
      if (!document.querySelector('[role="alertdialog"]')) return;
      watching.disconnect();
      const until = performance.now() + 1000;
      while (performance.now() < until) { /* busy */ }
    });
    watching.observe(document.body, { childList: true, subtree: true });
  });
  const clicks = await clicksHeard(page);
  const press = await presses(page);
  // The second press comes while the page is still busy, from someone who taps again because
  // nothing happened; neither waits for the page.
  const first = press.tap(point);
  await new Promise((later) => setTimeout(later, 300));
  await Promise.all([first, press.tap(point)]);
  await expect.poll(clicks).toEqual([{ inBox: false, on: "Delete" }, { inBox: true, on: "Delete" }]);
  await expect(box(page), "a yes to a question nobody could see").toBeVisible();
  expect(deletes).toHaveLength(0);

  await heardOnceRead(press.tap);
});

test("the second click of a double click on Delete from here lands on the button that confirms, and cuts nothing", { tag: "@desktop" }, async ({ page, request, isMobile }) => {
  test.skip(isMobile, "a phone has no double click: its double tap is the test before this one");
  // A width at which the box's button comes up over the buttons of a message.
  await page.setViewportSize({ width: 1024, height: 768 });
  const convo = await conversationWithReply(request);
  // A story longer than the screen, for a message to be scrolled to where the box's button comes up.
  for (const content of ["And then?", "Go on.", "What else?"]) {
    await chat(request, { conversation_id: convo.id, mode: "send", content });
  }
  const story = (await conversation(request, convo.id)).messages as { id: string }[];
  await boxStaysPut(page);
  await page.goto(`/#/chat/${convo.id}`);
  const messages = page.locator("[data-message-id]");
  await expect(messages).toHaveCount(story.length);

  await messages.last().hover();
  await messages.last().getByTitle("Delete from here").click();
  const confirms = (await page.getByRole("alertdialog").getByRole("button", { name: "Delete", exact: true }).boundingBox())!;
  await answer(page, false);

  // The first message whose own button can be brought to that height is scrolled there.
  const placed = await page.evaluate((y) => {
    const buttons = [...document.querySelectorAll<HTMLElement>('[data-message-id] button[title="Delete from here"]')];
    let scroller = buttons[0].parentElement!;
    while (scroller.scrollHeight <= scroller.clientHeight || getComputedStyle(scroller).overflowY === "visible") {
      scroller = scroller.parentElement!;
    }
    for (const button of buttons) {
      const at = button.getBoundingClientRect();
      const to = scroller.scrollTop + at.top + at.height / 2 - y;
      if (to >= 0 && to <= scroller.scrollHeight - scroller.clientHeight) {
        scroller.scrollTop = to;
        return button.closest("[data-message-id]")!.getAttribute("data-message-id");
      }
    }
    return null;
  }, confirms.y + confirms.height / 2);
  expect(placed, "no message can be scrolled to where the button that confirms comes up").not.toBeNull();
  const opener = page.locator(`[data-message-id="${placed}"]`).getByTitle("Delete from here");
  const point = onBoth((await opener.boundingBox())!, confirms);

  const deletes: string[] = [];
  page.on("request", (r) => r.method() === "DELETE" && deletes.push(r.url()));
  const clicks = await clicksHeard(page);
  const press = await presses(page);
  await page.mouse.move(point.x, point.y);
  // Both clicks of the double click sent back to back, neither waiting for the page.
  await Promise.all([press.click(point, 1), press.click(point, 2)]);
  await expect.poll(clicks).toEqual([{ inBox: false, on: "Delete from here" }, { inBox: true, on: "Delete" }]);
  await expect(page.getByRole("alertdialog"), "a yes to a question nobody had the time to read").toBeVisible();
  expect(deletes).toHaveLength(0);

  await answer(page, false);
  await expect(messages).toHaveCount(story.length);
  expect((await conversation(request, convo.id)).messages).toHaveLength(story.length);
});
