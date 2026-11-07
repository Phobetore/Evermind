import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { API } from "../playwright.config";
import { conversationWithReply, makeConversation } from "./fixtures";

/**
 * Small controls on a touch screen. The owner uses Evermind from his phone, and
 * two things went wrong there that a mouse never shows: a control that only
 * appears on hover never appears, and a control drawn 14px across is a control
 * a thumb misses. The first is a question of opacity; the second is answered by
 * asking the page what is under a finger at the edge of the 44px square around
 * each control, which is what "reachable" means, rather than by measuring the
 * picture. And the area added to a control must not end up over its neighbour:
 * a title that was wider than the box it was in once covered the button next
 * to it, which no measuring of that button could have shown.
 */

const FACTS = ["Mira keeps the key.", "The ferry runs on Tuesdays only.", "She does not take sugar."];

async function withFacts(request: APIRequestContext) {
  const convo = await conversationWithReply(request);
  for (const content of FACTS) {
    await request.post(`${API}/api/conversations/${convo.id}/memories`, { data: { content } });
  }
  return convo as { id: string; character_id: string };
}

/** A conversation as most of them are named: after the first message, cut at 60
 *  characters, which on a phone is more than the title has room for. */
async function withALongTitle(request: APIRequestContext) {
  const convo = await makeConversation(request);
  await request.post(`${API}/api/chat`, {
    data: {
      conversation_id: convo.id, mode: "send", message_mode: "say",
      content: "I came as soon as I could, and I brought everything you asked me for, so tell me what you owe me.",
    },
    timeout: 60_000,
  });
  const { title } = await (await request.get(`${API}/api/conversations/${convo.id}`)).json();
  expect(title.length, "the title is not long enough to test with").toBeGreaterThan(40);
  return convo as { id: string; character_id: string };
}

/** What the page says is under a point, for the middle of the control and for
 *  the edge of a 44px square around it, on each side. The points are one pixel
 *  inside that square, and the diagonals further in so that a rounded corner
 *  does not count against it. Anything that is not the control, or in it, is
 *  something that would take the touch. */
async function whatTakesTheTouch(control: Locator): Promise<string[]> {
  return control.evaluate((el) => {
    // To the middle of the screen: at the edge there may be a bar over it.
    el.scrollIntoView({ block: "center", inline: "center" });
    const box = el.getBoundingClientRect();
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    const stolen: string[] = [];
    for (const [dx, dy] of [[0, 0], [-21, 0], [21, 0], [0, -21], [0, 21], [-18, -18], [18, -18], [-18, 18], [18, 18]]) {
      const hit = document.elementFromPoint(x + dx, y + dy);
      // A label is answered by the control it labels, and the other way round.
      const labelled = hit?.closest("label")?.control === el;
      if (!hit || !(el.contains(hit) || labelled)) {
        stolen.push(`(${dx},${dy}) goes to ${hit ? hit.tagName.toLowerCase() + "." + String(hit.className).split(" ")[0] : "nothing"}`);
      }
    }
    return stolen;
  });
}

async function expectReachable(control: Locator, what: string) {
  expect(await whatTakesTheTouch(control), `${what} is not reachable across 44x44`).toEqual([]);
}

/** Every visible one of them, up to `max`: the shared database this suite runs
 *  against holds a great many cards and conversations from other tests. None
 *  visible at all is a failure, not a pass: there would be nothing looked at. */
async function expectAllReachable(controls: Locator, what: string, max = 12) {
  const visible = controls.filter({ visible: true });
  const count = Math.min(await visible.count(), max);
  expect(count, `no visible ${what} to look at`).toBeGreaterThan(0);
  for (let i = 0; i < count; i++) {
    const one = visible.nth(i);
    const label = (await one.getAttribute("aria-label")) ?? (await one.getAttribute("title")) ?? (await one.textContent()) ?? `#${i}`;
    await expectReachable(one, `${what} "${label?.trim()}"`);
  }
}

/** How much of a control can be seen: its own opacity and that of everything
 *  around it. Animations on the way in make it a moving number, hence the poll. */
function seen(control: Locator) {
  return control.evaluate((el) => {
    let opacity = 1;
    for (let n: Element | null = el; n; n = n.parentElement) opacity *= parseFloat(getComputedStyle(n).opacity);
    return opacity;
  });
}

/** Everything that comes in with an animation (the panel rises, the messages
 *  fade in) has arrived, so that what is measured is where it stays. */
function settled(page: Page) {
  return page.evaluate(() => Promise.all(
    document.getAnimations()
      .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
      // One that is cut short (an element going away) has still stopped.
      .map((a) => a.finished.catch(() => undefined)),
  ));
}

/** No touch area stuck out of what it belongs to is not something a picture
 *  shows: a box wider than its parent paints over what is beside it. This is
 *  about the elements that carry an added area, and where they are. */
async function expectInsideTheirParents(scope: Locator, what: string) {
  const { found, outside } = await scope.evaluate((root) => {
    const shown = [...root.querySelectorAll<HTMLElement>(".touch-target")]
      .filter((el) => el.getBoundingClientRect().width > 0);
    return {
      found: shown.length,
      outside: shown
        .filter((el) => {
          const own = el.getBoundingClientRect();
          const around = el.parentElement!.getBoundingClientRect();
          return own.left < around.left - 0.5 || own.right > around.right + 0.5
            || own.top < around.top - 0.5 || own.bottom > around.bottom + 0.5;
        })
        .map((el) => `${el.tagName.toLowerCase()} "${(el.textContent ?? "").trim().slice(0, 24)}"`),
    };
  });
  // Nothing found would be nothing looked at.
  expect(found, `${what}: no box with a touch area to look at`).toBeGreaterThan(0);
  expect(outside, `${what}: a box with a touch area is larger than the box it is in`).toEqual([]);
}

async function openPanel(page: Page, id: string) {
  await page.goto(`/#/chat/${id}`);
  await expect(page.locator("textarea").first()).toBeVisible();
  const opener = page.locator("header button:has(svg.lucide-sliders-horizontal)");
  if (await opener.isVisible()) await opener.click();
  const panel = page.locator("aside:visible:has(textarea)");
  await expect(panel).toBeVisible();
  await expect(panel.getByText(FACTS[0])).toBeVisible();
  await settled(page);
  return panel;
}

async function messagesIn(page: Page, id: string) {
  await page.goto(`/#/chat/${id}`);
  await expect(page.locator("[data-message-id]").first()).toBeVisible();
  await settled(page);
}

test.describe("on a touch screen", () => {
  test.skip(({ isMobile }) => !isMobile, "a phone is where thumbs are");

  test("the side panel's small controls can be seen and hit", async ({ page, request }) => {
    const convo = await withFacts(request);
    const panel = await openPanel(page, convo.id);

    const rows = panel.locator("div.group\\/fact");
    await expect(rows).toHaveCount(FACTS.length);
    const forget = panel.getByRole("button", { name: "Forget this fact" });
    const pin = panel.getByRole("button", { name: /^Pin/ });
    const close = panel.getByRole("button", { name: "Close panel" });

    // There is no hover to reveal it, and it is there to be used.
    await expect.poll(() => seen(forget.first()), "Forget is not visible without hover").toBeGreaterThan(0.5);

    // Same drawing as before: the reachable area is added to it, not made of it.
    for (const small of [pin.first(), forget.first()]) {
      const box = (await small.boundingBox())!;
      expect(Math.max(box.width, box.height), "a small control has grown").toBeLessThanOrEqual(16);
    }
    expect((await close.boundingBox())!.width, "Close has grown").toBeLessThanOrEqual(30);

    // Reachable across 44x44, every one of them, and not by taking over a
    // neighbour's: a point that belongs to the next row is a touch that goes
    // to the wrong fact.
    await expectReachable(close, "Close");
    await expectAllReachable(pin, "Pin");
    await expectAllReachable(forget, "Forget");
    for (let i = 0; i < FACTS.length; i++) {
      expect((await rows.nth(i).boundingBox())!.height, "a fact row is shorter than a thumb").toBeGreaterThanOrEqual(43.5);
    }

    // Every button in the panel, and as wide as it is tall: the "+" beside the
    // text box for a new fact was 38 across.
    await expectAllReachable(panel.getByRole("button"), "a button in the panel", 60);
    expect((await panel.getByRole("button", { name: "Add fact" }).boundingBox())!.width, "the button for a new fact is narrower than a thumb").toBeGreaterThanOrEqual(43.5);
    await expectInsideTheirParents(panel, "in the panel");

    // And a touch that is not on the picture, but within its square: 18px
    // to the side of the cross.
    const cross = (await forget.first().boundingBox())!;
    await page.touchscreen.tap(cross.x + cross.width / 2 - 18, cross.y + cross.height / 2);
    await expect(rows).toHaveCount(FACTS.length - 1);
    const mark = (await pin.first().boundingBox())!;
    await expect(panel.getByRole("button", { name: "Unpin" })).toHaveCount(0);
    await page.touchscreen.tap(mark.x + mark.width / 2 + 18, mark.y + mark.height / 2);
    await expect(panel.getByRole("button", { name: "Unpin" })).toHaveCount(1);
  });

  test("the actions of a message can be hit, and stay on the screen", async ({ page, request }) => {
    const convo = await withFacts(request);
    // A second variant of the reply, so that the arrows between them are there.
    await request.post(`${API}/api/chat`, {
      data: { conversation_id: convo.id, mode: "regenerate" }, timeout: 60_000,
    });
    for (const width of [412, 360, 320]) {
      await page.setViewportSize({ width, height: 800 });
      await messagesIn(page, convo.id);

      const actions = page.locator("[data-message-id] button");
      await expectAllReachable(actions, `a message's action at ${width}px`);

      // Wider than the screen is as bad as too small for it.
      const gone = await page.evaluate((w) =>
        [...document.querySelectorAll<HTMLElement>("[data-message-id] button")]
          .filter((b) => b.getBoundingClientRect().width > 0 && b.getBoundingClientRect().right > w + 0.5)
          .map((b) => b.getAttribute("title") ?? b.getAttribute("aria-label")), width);
      expect(gone, `actions past the right edge at ${width}px`).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth), `the page scrolls sideways at ${width}px`).toBeLessThanOrEqual(width);

      // Where the six of the last reply do not fit on one line they are on two,
      // not five and one on its own.
      const last = page.locator("[data-message-id]").last().locator("button[title]");
      const lines = await last.evaluateAll((buttons) => {
        const perLine = new Map<number, number>();
        for (const b of buttons) {
          const top = Math.round(b.getBoundingClientRect().top);
          perLine.set(top, (perLine.get(top) ?? 0) + 1);
        }
        return [...perLine.values()];
      });
      expect(lines.reduce((a, b) => a + b, 0), "the last reply is missing actions").toBe(6);
      expect(lines.filter((n) => n === 1), `an action on a line by itself at ${width}px: ${lines}`).toEqual([]);
    }
  });

  test("the header of a conversation, and the list of them, can be hit", async ({ page, request }) => {
    const convo = await withFacts(request);
    await messagesIn(page, convo.id);
    await expectAllReachable(page.locator("header a, header button"), "a control in the header");
    await expectInsideTheirParents(page.locator("header"), "in the header");

    await page.goto("/#/chat");
    const rename = page.getByRole("button", { name: "Rename" }).first();
    await expect(rename).toBeVisible();
    await settled(page);
    await expect.poll(() => seen(rename), "Rename is not visible without hover").toBeGreaterThan(0.5);
    await expectAllReachable(page.locator("a.group button"), "an action on a conversation in the list");
  });

  test("a long title does not take the buttons beside it", async ({ page, request }) => {
    const convo = await withALongTitle(request);
    for (const width of [412, 390, 360, 320]) {
      await page.setViewportSize({ width, height: 800 });
      await messagesIn(page, convo.id);
      await page.locator("aside:visible:has(textarea)").waitFor({ state: "hidden" });

      // The title is cut, not spread: it is wider than its place, if it is not.
      const title = page.locator("header button[title]").first();
      expect(
        await title.locator("span").evaluate((span) => span.scrollWidth > span.clientWidth),
        `the title is not cut at ${width}px, so it is not what is being tested`,
      ).toBe(true);
      await expectInsideTheirParents(page.locator("header"), `with a long title at ${width}px`);
      await expectReachable(title, "the title");

      // And the button beside it opens what it says it opens, by a real touch
      // in the middle of it.
      const opener = page.locator("header button:has(svg.lucide-sliders-horizontal)");
      await expectReachable(opener, "the memory and settings button");
      const box = (await opener.boundingBox())!;
      await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
      await expect(page.locator("aside:visible:has(textarea)"), `the button did not open the panel at ${width}px`).toBeVisible();
      await page.locator("aside:visible:has(textarea)").getByRole("button", { name: "Close panel" }).click();

      // While the title is being edited the text box that takes its place is as
      // wide as the box it is in, and stays clear of the button beside it,
      // which is still the button it was.
      const at = (await title.boundingBox())!;
      await page.touchscreen.tap(at.x + at.width / 2, at.y + at.height / 2);
      const editor = page.locator("header input");
      await expect(editor, `the title did not turn into a text box at ${width}px`).toBeVisible();
      const [field, room, beside] = await Promise.all([
        editor.boundingBox(),
        editor.locator("xpath=..").boundingBox(),
        opener.boundingBox(),
      ]);
      expect(field!.x + field!.width, `the text box for the title is wider than its place at ${width}px`).toBeLessThanOrEqual(room!.x + room!.width + 0.5);
      expect(field!.x + field!.width, `the text box for the title runs under the button beside it at ${width}px`).toBeLessThanOrEqual(beside!.x + 0.5);
      await expectReachable(opener, "the memory and settings button, while the title is edited");
      await page.touchscreen.tap(beside!.x + beside!.width / 2, beside!.y + beside!.height / 2);
      await expect(page.locator("aside:visible:has(textarea)"), `the button did not open the panel while the title was edited at ${width}px`).toBeVisible();
      await page.locator("aside:visible:has(textarea)").getByRole("button", { name: "Close panel" }).click();
    }
  });

});

test.describe("with a mouse", () => {
  test.skip(({ isMobile }) => isMobile, "a mouse is what a laptop has");

  test("what shows on hover still shows on hover, and nothing has grown", async ({ page, request }) => {
    const convo = await withFacts(request);
    const panel = await openPanel(page, convo.id);

    const rows = panel.locator("div.group\\/fact");
    const forget = rows.first().getByRole("button", { name: "Forget this fact" });
    const pin = rows.first().getByRole("button", { name: /^Pin/ });

    // Away from the row it is not there, and over the row it is.
    await page.mouse.move(2, 2);
    await expect(forget).toHaveCSS("opacity", "0");
    await rows.first().hover();
    await expect(forget).toHaveCSS("opacity", "1");
    await page.mouse.move(2, 2);
    await expect(forget).toHaveCSS("opacity", "0");

    // The cross still changes colour over it, with a transition, as it did.
    expect(await forget.evaluate((el) => getComputedStyle(el).transitionProperty), "no colour transition on the cross").toContain("color");

    // No reachable area added where a pointer is precise, and no taller rows.
    for (const small of [forget, pin]) {
      const box = (await small.boundingBox())!;
      expect(Math.max(box.width, box.height)).toBeLessThanOrEqual(16);
      expect(await small.evaluate((el) => getComputedStyle(el, "::after").content), "reachable area added on a mouse").toBe("none");
    }
    expect((await rows.first().boundingBox())!.height, "a fact row is taller than it was").toBeLessThan(40);

    // A card's button is for the mouse to find.
    await page.goto("/#/");
    const start = page.getByRole("button", { name: "Start", exact: true }).first();
    await page.mouse.move(2, 2);
    await expect(start).toHaveCSS("opacity", "0");
    await start.locator("xpath=ancestor::a[1]").hover();
    await expect(start).toHaveCSS("opacity", "1");

    // A narrow window is not a touch screen: the fields keep their size.
    await page.setViewportSize({ width: 600, height: 800 });
    await page.goto("/#/settings");
    const menu = page.locator("main select.field").first();
    await expect(menu).toBeVisible();
    expect((await menu.boundingBox())!.height, "a menu grew in a narrow window with a mouse").toBeLessThan(42);
  });

});
