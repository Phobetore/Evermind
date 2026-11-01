import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { API } from "../playwright.config";
import { conversationWithReply } from "./fixtures";

/**
 * Small controls on a touch screen. The owner uses Evermind from his phone, and
 * two things went wrong there that a mouse never shows: a control that only
 * appears on hover never appears, and a control drawn 14px across is a control
 * a thumb misses. The first is a question of opacity; the second is answered by
 * asking the page what is under a finger at the edge of the 44px square around
 * each control, which is what "reachable" means, rather than by measuring the
 * picture.
 */

const FACTS = ["Mira keeps the key.", "The ferry runs on Tuesdays only.", "She does not take sugar."];

async function withFacts(request: APIRequestContext) {
  const convo = await conversationWithReply(request);
  for (const content of FACTS) {
    await request.post(`${API}/api/conversations/${convo.id}/memories`, { data: { content } });
  }
  return convo as { id: string; character_id: string };
}

/** The page's own answer to "what is at this point", for the middle of the
 *  control and for the edge of a 44px square around it, on each side. The
 *  points are one pixel inside that square, and the diagonals further in so that
 *  a rounded corner does not count against it. Anything that is not the
 *  control, or in it, is something that would take the touch. */
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

/** Every one of them, up to a dozen: the shared database this suite runs
 *  against holds a great many cards and conversations from other tests. */
async function expectAllReachable(controls: Locator, what: string) {
  const count = Math.min(await controls.count(), 12);
  expect(count, `no ${what} to look at`).toBeGreaterThan(0);
  for (let i = 0; i < count; i++) {
    const one = controls.nth(i);
    if (await one.isVisible()) {
      const label = (await one.getAttribute("aria-label")) ?? (await one.getAttribute("title")) ?? (await one.textContent()) ?? `#${i}`;
      await expectReachable(one, `${what} "${label?.trim()}"`);
    }
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

async function openPanel(page: Page, id: string) {
  await page.goto(`/#/chat/${id}`);
  await expect(page.locator("textarea").first()).toBeVisible();
  const opener = page.locator("header button:has(svg.lucide-sliders-horizontal)");
  if (await opener.isVisible()) await opener.click();
  const panel = page.locator("aside:visible:has(textarea)");
  await expect(panel).toBeVisible();
  await expect(panel.getByText(FACTS[0])).toBeVisible();
  return panel;
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
      await page.goto(`/#/chat/${convo.id}`);
      await expect(page.locator("[data-message-id]").first()).toBeVisible();
      await page.waitForTimeout(700); // the messages fade in

      const actions = page.locator("[data-message-id] button");
      await expectAllReachable(actions, `a message's action at ${width}px`);

      // Wider than the screen is as bad as too small for it.
      const gone = await page.evaluate((w) =>
        [...document.querySelectorAll<HTMLElement>("[data-message-id] button")]
          .filter((b) => b.getBoundingClientRect().width > 0 && b.getBoundingClientRect().right > w + 0.5)
          .map((b) => b.getAttribute("title") ?? b.getAttribute("aria-label")), width);
      expect(gone, `actions past the right edge at ${width}px`).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth), `the page scrolls sideways at ${width}px`).toBeLessThanOrEqual(width);
    }
  });

  test("the header of a conversation, and the list of them, can be hit", async ({ page, request }) => {
    const convo = await withFacts(request);
    await page.goto(`/#/chat/${convo.id}`);
    await expect(page.locator("[data-message-id]").first()).toBeVisible();
    await expectAllReachable(page.locator("header a, header button"), "a control in the header");

    await page.goto("/#/chat");
    const rename = page.getByRole("button", { name: "Rename" }).first();
    await expect(rename).toBeVisible();
    await expect.poll(() => seen(rename), "Rename is not visible without hover").toBeGreaterThan(0.5);
    await expectAllReachable(page.locator("a.group button"), "an action on a conversation in the list");
  });

  test("the tags, the lorebook and a window's own button can be hit", async ({ page, request }) => {
    const convo = await withFacts(request);
    await request.put(`${API}/api/characters/${convo.character_id}`, {
      data: { name: "Vane", tags: ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota", "kappa"] },
    });
    for (const key of ["harbour", "ferry"]) {
      await request.post(`${API}/api/characters/${convo.character_id}/lore`, {
        data: { keys: [key], content: `About the ${key}.` },
      });
    }

    // The chips that filter the home page, in a rail that scrolls sideways and
    // would clip anything added to them.
    await page.goto("/#/");
    const chip = page.getByRole("button", { name: "alpha", exact: true });
    await expect(chip).toBeVisible();
    await expectAllReachable(page.locator("div.overflow-x-auto button"), "a tag chip");

    // A window's own button.
    await page.getByRole("button", { name: /import/i }).first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expectReachable(dialog.getByRole("button", { name: "Close" }), "Close on a window");
    await page.keyboard.press("Escape");

    // In the editor: the little crosses on a card's tags, the lorebook's
    // controls, the toggle for the advanced part, and the fields.
    await page.goto(`/#/characters/${convo.character_id}/edit`);
    await expect(page.getByRole("button", { name: "Remove alpha" })).toBeVisible();
    await expectAllReachable(page.getByRole("button", { name: /^Remove / }), "a tag's cross");
    await expectAllReachable(page.getByRole("button", { name: /delete entry/i }), "a lorebook entry's delete button");
    await expectAllReachable(page.locator("label:has(input[type=checkbox])"), "a lorebook entry's switch");
    await expectReachable(page.getByRole("button", { name: /advanced/i }), "the advanced settings toggle");

    // A text box is something to hit too.
    for (const field of await page.locator("select.field, input.field").all()) {
      if (await field.isVisible()) {
        expect((await field.boundingBox())!.height, "a field is shorter than a thumb").toBeGreaterThanOrEqual(43.5);
      }
    }
  });

  test("on a tablet, which is touched too, the same holds", async ({ page, request }) => {
    const convo = await withFacts(request);
    await request.post(`${API}/api/chat`, {
      data: { conversation_id: convo.id, mode: "regenerate" }, timeout: 60_000,
    });
    await page.setViewportSize({ width: 820, height: 1000 });

    // A button that shows on a card when a mouse is over it, shown always.
    await page.goto("/#/");
    const start = page.getByRole("button", { name: "Start", exact: true }).first();
    await expect.poll(() => seen(start), "the button on a card is not visible without hover").toBeGreaterThan(0.9);

    await page.goto(`/#/chat/${convo.id}`);
    await expect(page.locator("[data-message-id]").first()).toBeVisible();
    await page.waitForTimeout(700);
    await expectAllReachable(page.locator("[data-message-id] button"), "a message's action on a tablet");
    await expectAllReachable(page.locator("header a, header button"), "a control in the header on a tablet");
    await expectAllReachable(page.getByRole("button", { name: /close/i }), "Close on a tablet");

    await page.goto("/#/");
    await page.getByRole("button", { name: /import/i }).first().click();
    await expectReachable(page.getByRole("dialog").getByRole("button", { name: "Close" }), "Close on a window, on a tablet");
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

    // Away from the row it is not there, over the row it is, and a keyboard
    // that reaches it sees it.
    await page.mouse.move(2, 2);
    await expect(forget).toHaveCSS("opacity", "0");
    await rows.first().hover();
    await expect(forget).toHaveCSS("opacity", "1");
    await page.mouse.move(2, 2);
    await expect(forget).toHaveCSS("opacity", "0");
    await forget.focus();
    await expect(forget).toHaveCSS("opacity", "1");

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
  });
});
