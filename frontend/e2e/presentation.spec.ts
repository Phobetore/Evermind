import { expect, test, type BrowserContext, type Locator, type Page, type Request } from "@playwright/test";
import { crc32, deflateSync } from "node:zlib";
import { API } from "../playwright.config";
import { layoutRefusal } from "../src/lib/presentation/bounds";
import { answer, makeCharacter, PNG, policyViolations, watchPolicy } from "./fixtures";

/** A card's presentation on its page: laid out through the allow-list, its images of other sites
 *  asked for only on a tap, its links honest about where they lead, and the page around it out of
 *  its reach. */

const DOT = `data:image/png;base64,${PNG.toString("base64")}`;

// The cards each test sows, deleted after it with their conversations: the home page of every
// later test would draw them.
const made: string[] = [];
// What reached the sites of the tests, and the pages a test opened besides its own.
const asked: Request[] = [];
const opened: Page[] = [];
const dialogs: string[] = [];

/** A PNG header of 33 bytes: what the page reads of the size, with nothing to decode behind it. */
function pngHeader(width: number, height: number): string {
  const header = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]).copy(header);
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  header[24] = 8;
  header[25] = 6;
  return `data:image/png;base64,${header.toString("base64")}`;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const chunk = Buffer.alloc(body.length + 8);
  chunk.writeUInt32BE(data.length, 0);
  body.copy(chunk, 4);
  chunk.writeUInt32BE(crc32(body), body.length + 4);
  return chunk;
}

/** A real PNG one pixel wide and `height` high, grey, written byte by byte. */
function tallPng(height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 0; // greyscale
  const rows = Buffer.alloc(height * 2);
  for (let i = 0; i < height; i++) rows[2 * i + 1] = 128; // filter byte 0, then the pixel
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(rows)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const TALL = tallPng(4_000);

async function serveTestSites(context: BrowserContext) {
  await context.route(/^https:\/\/[^/]*\.example\//, (route) => {
    asked.push(route.request());
    const url = new URL(route.request().url());
    if (url.hostname !== "site.example" && url.pathname === "/missing.png") return route.fulfill({ status: 404 });
    if (url.pathname === "/tall.png") return route.fulfill({ body: TALL, contentType: "image/png" });
    if (url.hostname === "site.example") return route.fulfill({ body: "<p>A site</p>", contentType: "text/html" });
    return route.fulfill({ body: PNG, contentType: "image/png" });
  });
}

test.beforeEach(async ({ page, context }) => {
  asked.length = 0;
  opened.length = 0;
  dialogs.length = 0;
  await watchPolicy(page);
  page.on("dialog", (dialog) => {
    dialogs.push(`${dialog.type()} ${dialog.message()}`);
    void dialog.dismiss();
  });
  context.on("page", (other) => opened.push(other));
  await serveTestSites(context);
});

test.afterEach(async ({ page, request }) => {
  expect(dialogs, "the page opened a dialog of the browser").toEqual([]);
  expect(await policyViolations(page), "the page broke its policy or threw").toEqual([]);
  for (const id of made.splice(0)) await request.delete(`${API}/api/characters/${id}`);
});

const frame = (page: Page) => page.locator(".card-presentation");
const toPictures = () => asked.filter((r) => new URL(r.url()).hostname === "pictures.example");

/** A card whose presentation is `notes`, its page open, and laid out unless `plain`. */
async function openCard(page: Page, notes: string, { plain = false } = {}): Promise<Locator> {
  // A name of its own: when a test opens a second card, its heading says the page has changed.
  const name = `Presented ${made.length + 1}`;
  const card = await makeCharacter(page.request, { name, creator_notes: notes });
  made.push(card.id);
  await page.goto(`/#/characters/${card.id}`);
  await expect(page.getByRole("heading", { level: 1, name, exact: true })).toBeVisible();
  await expect(frame(page)).toBeVisible();
  if (!plain) {
    // Shown plainly until the layout arrives: what is measured is the laid-out text.
    await expect
      .poll(() => frame(page).evaluate((e) => !e.querySelector(":scope > p.whitespace-pre-wrap")), {
        message: "the presentation was not laid out",
      })
      .toBe(true);
  }
  return frame(page);
}

/** Unfolds the presentation when it is folded. */
async function unfold(page: Page) {
  // The fold is measured once the text is drawn, two frames at most after it.
  await page.evaluate(() => new Promise((drawn) => requestAnimationFrame(() => requestAnimationFrame(drawn))));
  const more = page.getByRole("button", { name: "Read more" });
  if (await more.count()) await more.click();
}

const rect = (locator: Locator) => locator.evaluate((e) => e.getBoundingClientRect().toJSON() as DOMRect);

/** The frame's rectangle less its border and its padding: where the card's text may go. */
const inner = (locator: Locator) =>
  locator.evaluate((e) => {
    const r = e.getBoundingClientRect();
    const s = getComputedStyle(e);
    const px = (v: string) => parseFloat(v) || 0;
    return {
      left: r.left + px(s.borderLeftWidth) + px(s.paddingLeft),
      right: r.right - px(s.borderRightWidth) - px(s.paddingRight),
      width: r.width - px(s.borderLeftWidth) - px(s.paddingLeft) - px(s.borderRightWidth) - px(s.paddingRight),
    };
  });

const style = (locator: Locator, name: string, pseudo?: string) =>
  locator.evaluate((e, [n, p]) => getComputedStyle(e, p ?? null).getPropertyValue(n), [name, pseudo] as const);

const hexToRgb = (hex: string) => {
  const h = hex.trim().replace("#", "");
  return `rgb(${parseInt(h.slice(0, 2), 16)}, ${parseInt(h.slice(2, 4), 16)}, ${parseInt(h.slice(4, 6), 16)})`;
};

test("a presentation is laid out with its colours, table and links @desktop", async ({ page }) => {
  const colours = [
    "rebeccapurple", "#abc", "#abcd", "#aabbcc", "#aabbccdd", "rgb(10, 20, 30)", "rgb(10%, 20%, 30%)",
    "rgba(10, 20, 30, 0.5)", "rgb(10 20 30 / 0.5)", "rgb(10% 20% 30%)", "hsl(120, 50%, 50%)", "hsl(120 50% 50% / 0.5)",
  ];
  const box = await openCard(page, [
    "# Heading",
    "Some **bold** words.",
    "| a | b |\n|---|---|\n| 1 | 2 |",
    '<span style="color: rgb(227, 0, 83)">RED</span>',
    "[the site](https://site.example/a)",
    "Bare: https://site.example/n",
    `<p><img src="${DOT}" alt="wide" style="width: 100%"></p>`,
    '<a href="https://site.example/g" style="color: rgb(0, 128, 0)">green</a>',
    `<div style="color: rgb(1, 2, 3)">${colours.map((c, i) => `<span style="color: ${c}">C${i}</span>`).join(" ")}</div>`,
    '<div style="max-width: 300px; margin: 0 auto">centred column</div>',
  ].join("\n\n"));

  await expect(box.locator("h3", { hasText: "Heading" })).toBeVisible();
  await expect(box.locator("strong", { hasText: "bold" })).toBeVisible();
  await expect(box.locator("table td", { hasText: "2" })).toBeVisible();
  expect(await style(box.getByText("RED", { exact: true }), "color")).toBe("rgb(227, 0, 83)");

  const link = box.locator('a[href="https://site.example/a"]');
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", "noopener noreferrer nofollow");
  await expect(box.getByText("Bare: https://site.example/n")).toBeVisible();
  await expect(box.locator('a[href="https://site.example/n"]')).toHaveCount(0);

  const image = box.locator('img[alt="wide"]');
  await expect(image).toBeVisible();
  const widths = await image.evaluate((img) => [img.getBoundingClientRect().width, img.parentElement!.clientWidth]);
  expect(Math.abs(widths[0] - widths[1])).toBeLessThan(1);

  expect(await style(box.locator('a[href="https://site.example/g"]'), "color")).toBe("rgb(0, 128, 0)");
  for (let i = 0; i < colours.length; i++) {
    expect(await style(box.getByText(`C${i}`, { exact: true }), "color"), colours[i]).not.toBe("rgb(1, 2, 3)");
  }
  const column = await rect(box.getByText("centred column", { exact: true }));
  expect(column.width).toBeCloseTo(300, 0);
});

test("headings, lists, paragraphs and tables keep their look @desktop", async ({ page }) => {
  const box = await openCard(page, [
    "# Title",
    "First paragraph.",
    "Second paragraph, with [a link](https://site.example/l).",
    "- one\n- two",
    "1. first\n2. second",
    "| h1 | h2 |\n|----|----|\n| c1 | c2 |",
    "---",
    `A sentence with ![dot](${DOT}) inside.`,
    "## Mid",
    "### Low",
    "###### Least",
    "~~gone~~",
  ].join("\n\n"));

  const paragraph = box.locator("p", { hasText: "First paragraph." });
  const size = (l: Locator) => style(l, "font-size").then(parseFloat);
  const pSize = await size(paragraph);
  const title = box.locator("h3", { hasText: "Title" });
  expect(await size(title)).toBeGreaterThanOrEqual(1.3 * pSize);
  expect(Number(await style(title, "font-weight"))).toBeGreaterThanOrEqual(600);
  expect(parseFloat(await style(paragraph, "margin-bottom"))).toBeGreaterThan(0);
  const bullets = box.locator("ul");
  expect(await style(bullets, "list-style-type")).toBe("disc");
  expect(parseFloat(await style(bullets, "padding-left"))).toBeGreaterThan(0);
  expect(await style(box.locator("ol"), "list-style-type")).toBe("decimal");
  const cells = box.locator("td");
  await expect(cells).toHaveCount(2);
  for (const cell of await cells.all()) {
    expect(await style(cell, "border-top-width")).toBe("1px");
    expect(parseFloat(await style(cell, "padding-left"))).toBeGreaterThan(0);
  }
  expect(await style(box.locator("hr"), "border-top-width")).toBe("1px");
  expect(await style(box.locator('img[alt="dot"]'), "display")).toBe("inline");
  expect(await style(box.locator("a", { hasText: "a link" }), "text-decoration-line")).toBe("underline");

  const h4 = await size(box.locator("h4", { hasText: "Mid" }));
  const h5 = await size(box.locator("h5", { hasText: "Low" }));
  const h6 = await size(box.locator("h6", { hasText: "Least" }));
  expect(h4).toBeGreaterThan(h5);
  expect(h5).toBeGreaterThan(h6);
  expect(h5).toBeGreaterThan(pSize);
  expect(h6).toBeGreaterThanOrEqual(pSize);
  const gone = box.locator("del", { hasText: "gone" });
  expect(await style(gone, "text-decoration-line")).toBe("line-through");
});

test("an image far taller than wide stays within three screens", async ({ page }) => {
  const tall = `data:image/png;base64,${TALL.toString("base64")}`;
  const box = await openCard(page, [
    `<img src="${tall}" alt="plain">`,
    `<img src="${tall}" alt="wide" style="width: 100%">`,
    '<img src="https://pictures.example/tall.png" alt="remote">',
  ].join("\n\n"));
  // Folded once the images are decoded, which makes the text taller.
  await page.getByRole("button", { name: "Read more" }).click();
  await page.getByRole("button", { name: "Show the image from pictures.example" }).click();

  const screen = await page.evaluate(() => window.innerHeight);
  for (const alt of ["plain", "wide", "remote"]) {
    const image = box.locator(`img[alt="${alt}"]`);
    // Drawn lazily: brought near the screen, as a person scrolling would.
    await image.scrollIntoViewIfNeeded();
    await expect.poll(() => image.evaluate((i: HTMLImageElement) => i.naturalHeight), { message: alt }).toBe(4_000);
    expect((await rect(image)).height, alt).toBeLessThanOrEqual(3 * screen + 1);
  }
  const whole = await rect(box);
  expect(whole.bottom - whole.top).toBeLessThan(10 * screen);
});

test("a hostile presentation runs nothing and covers nothing @desktop", async ({ page }) => {
  const before = await page.goto("/").then(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor));
  const box = await openCard(page, [
    "<script>window.__hit = 1</script>",
    '<img src=x onerror="window.__hit=1">',
    "[x](javascript:window.__hit=1)",
    '<form action="https://site.example/f"><input type="password"><button>Sign in</button></form>',
    '<div style="position:fixed;inset:0;z-index:9999;background:red">cover</div>',
    '<div style="margin-top:-500px">up</div>',
    "<style>body{background:red}</style>",
    `<img src="${DOT}" alt="corner" style="position: fixed; bottom: 0px; right: 5px; width: auto; height: 35%; z-index: 99; pointer-events: none;">`,
  ].join("\n\n"));

  await expect(box.locator('img[alt="corner"]')).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __hit?: number }).__hit)).toBeUndefined();
  await expect(box.locator("input, form, button")).toHaveCount(0);
  expect(await style(box.locator('img[alt="corner"]'), "position")).toBe("static");
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(before);

  const start = page.getByRole("button", { name: "Start a conversation" });
  const centre = await rect(start);
  const hit = await page.evaluate(
    ([x, y]) => {
      const found = document.elementFromPoint(x, y);
      return !!found?.closest("button")?.textContent?.includes("Start a conversation");
    },
    [centre.x + centre.width / 2, centre.y + centre.height / 2],
  );
  expect(hit, "something of the card lies over the real button").toBe(true);
  await start.click();
  await expect(page.getByRole("dialog")).toBeVisible();
});

test("the presentation is set apart from the page, and a link stays a link", async ({ page }) => {
  const box = await openCard(page, [
    '<a href="https://site.example/s" style="display: inline-block; background-color: #16a34a; color: white; padding: 12px; border-radius: 8px; text-decoration: none">Start a conversation</a>',
    '<a href="https://site.example/s"><span style="display: inline-block; background-color: #16a34a; padding: 12px">Start a conversation</span></a>',
    `<a href="https://site.example/s"><img src="${DOT}" alt="Start a conversation"></a>`,
    `<a href="https://site.example/s"><img src="${DOT}" alt="Start a conversation"><span style="color:#0f0d12">.</span></a>`,
    '<details><summary style="display: inline-block; list-style: none; background-color: #16a34a; color: #16a34a; width: 220px; margin: 0 auto; padding: 12px; border-radius: 8px; font-size: 11px"><span style="color: white">Start a conversation</span></summary>x</details>',
  ].join("\n\n"));

  expect(parseFloat(await style(box, "border-top-width"))).toBeGreaterThanOrEqual(1);
  const links = box.locator("a");
  expect(await style(links.nth(0), "text-decoration-line")).toBe("underline");
  await expect(page.getByRole("button", { name: "Start a conversation" })).toBeVisible();
  await expect(box.getByRole("button", { name: "Start a conversation" })).toHaveCount(0);
  expect(await style(links.nth(1).locator("span"), "text-decoration-line")).toBe("underline");

  for (const index of [2, 3]) {
    const pictured = links.nth(index);
    await expect(pictured).not.toHaveAttribute("href");
    await pictured.click();
    const asking = page.getByRole("alertdialog", { name: "This link holds a picture. Open it?" });
    await expect(asking).toBeVisible();
    await expect(asking.getByText("It leads to site.example")).toBeVisible();
    await expect(asking.locator("bdi", { hasText: "site.example" })).toBeVisible();
    await answer(page, false);
  }
  expect(opened, "a page was opened").toEqual([]);

  const summary = box.locator("summary");
  expect(await style(summary, "display")).toBe("block");
  expect(await style(summary, "content", "::before")).toBe('"▸"');
  const root = await page.evaluate(() => {
    const s = getComputedStyle(document.documentElement);
    return [s.getPropertyValue("--color-parchment"), s.getPropertyValue("--color-ink-800")];
  });
  const triangle = await style(summary, "color", "::before");
  expect(triangle).toBe(hexToRgb(root[0]));
  expect(await style(summary, "background-color", "::before")).toBe(hexToRgb(root[1]));
  expect(await style(summary, "font-size", "::before")).toBe("16px");
  expect(triangle).not.toBe(await style(summary, "background-color"));
  const before = asked.length;
  await summary.click();
  expect(await style(summary, "content", "::before")).toBe('"▾"');
  const details = box.locator("details");
  await expect(details).toHaveAttribute("open", "");
  await expect(details).toContainText("x");
  expect((await rect(details)).height).toBeGreaterThan((await rect(summary)).height);
  expect(asked.length).toBe(before);
  expect(opened).toEqual([]);
});

test("the deepest text stays inside the frame", async ({ page }) => {
  const list = Array.from({ length: 20 }, (_, i) => `${"  ".repeat(i)}- ${i === 19 ? "DEEPLIST" : `level${i}`}`).join("\n");
  const words = Array.from({ length: 100 }, (_, i) => `w${String(i + 1).padStart(3, "0")}word`);
  const box = await openCard(page, [
    `${"> ".repeat(20)}DEEPQUOTE`,
    list,
    // Forty-eight: code is an element the HTML parser rebuilds, and sixty pass the bound of what
    // it may rebuild (below).
    `${'<code style="display: block">'.repeat(48)}DEEPCODE${"</code>".repeat(48)}`,
    `${"<pre>".repeat(20)}DEEPPRE${"</pre>".repeat(20)}`,
    `${'<mark style="display: block">'.repeat(20)}DEEPMARK${"</mark>".repeat(20)}`,
    `<div style="display: flex">${words.map((w) => `<span>${w}</span>`).join("")}</div>`,
  ].join("\n\n"));
  await unfold(page);

  const inFrame = async (frameOf: Locator, word: string) => {
    const bounds = await inner(frameOf);
    const r = await rect(frameOf.getByText(word, { exact: true }));
    expect(r.right, word).toBeLessThanOrEqual(bounds.right + 0.5);
    expect(r.width, word).toBeGreaterThanOrEqual(40);
  };
  for (const word of ["DEEPQUOTE", "DEEPLIST", "DEEPCODE", "DEEPPRE", "DEEPMARK", ...words]) await inFrame(box, word);

  // Sixty are refused as too dense, and shown without their layout, in the same frame.
  const dense = await openCard(
    page,
    `${'<code style="display: block">'.repeat(60)}DENSECODE${"</code>".repeat(60)}`,
    { plain: true },
  );
  await expect(page.getByText("Too dense to lay out: shown without its layout.")).toBeVisible();
  await expect(dense.locator("code")).toHaveCount(0);
  await unfold(page);
  await inFrame(dense, "DENSECODE");
});

test("a Show button stays the one that is tapped", async ({ page }) => {
  const box = await openCard(page, [
    "![pic](https://pictures.example/a.png)",
    '<div style="line-height: 1"><a href="https://site.example/x" style="padding: 4px 0; background-color: #16121d">xxxxxxxxxxxxxxxxxxxx</a> <span style="padding: 64px 0; background-color: #16121d">yyyy</span> <div style="display: inline; padding: 64px 0; background-color: #16121d">zzzz</div></div>',
  ].join("\n"));

  const show = box.getByRole("button", { name: "Show the image from pictures.example" });
  // elementFromPoint sees only what is on screen.
  await show.scrollIntoViewIfNeeded();
  const r = await rect(show);
  for (const [x, y] of [[r.x + r.width / 2, r.y + r.height / 2], [r.x + r.width / 2, r.bottom - 2]]) {
    const onIt = await show.evaluate((button, [px, py]) => {
      const found = document.elementFromPoint(px, py);
      return !!found && button.contains(found);
    }, [x, y]);
    expect(onIt, `the Show button is not what lies at ${x}, ${y}`).toBe(true);
  }
  await show.click();
  await expect.poll(() => toPictures().length).toBe(1);
  expect(opened).toEqual([]);
});

test("no other site is contacted before a tap, and a tap sends no address of the app", async ({ page }) => {
  const box = await openCard(page, [
    "![md](https://pictures.example/md.png)",
    '<img src="https://pictures.example/html.png" alt="html">',
    "[![linked](https://pictures.example/linked.png)](https://site.example/l)",
    "[the site](https://site.example/h)",
  ].join("\n\n"));
  await unfold(page);
  await page.evaluate(() => window.scrollTo(0, document.scrollingElement!.scrollHeight));
  await page.waitForTimeout(500);
  expect(toPictures(), "an image of another site was asked for before a tap").toEqual([]);

  const contacts = page.getByText("Will contact: pictures.example");
  const showAll = page.getByRole("button", { name: "Show images" });
  await expect(contacts).toBeVisible();
  await expect(showAll).toBeVisible();
  await expect(box.getByText("Will contact: pictures.example")).toHaveCount(0);
  await expect(box.getByRole("button", { name: "Show images" })).toHaveCount(0);
  const ownButtons = box.getByRole("button", { name: "Show the image from pictures.example" });
  await expect(ownButtons).toHaveCount(2);

  await ownButtons.first().click();
  await expect.poll(() => toPictures().length).toBe(1);
  expect((await toPictures()[0].allHeaders()).referer).toBeUndefined();
  const first = box.locator('img[alt="md"]');
  await expect(first).toBeVisible();
  await expect(first).toHaveAttribute("referrerpolicy", "no-referrer");

  await showAll.click();
  await expect.poll(() => toPictures().length).toBe(3);
  for (const shown of toPictures()) expect((await shown.allHeaders()).referer, shown.url()).toBeUndefined();
  for (const alt of ["html", "linked"]) {
    await expect(box.locator(`img[alt="${alt}"]`)).toBeVisible();
    await expect(box.locator(`img[alt="${alt}"]`)).toHaveAttribute("referrerpolicy", "no-referrer");
  }
  const links = box.locator("a[href]");
  await expect(links).not.toHaveCount(0);
  for (const link of await links.all()) await expect(link).toHaveAttribute("referrerpolicy", "no-referrer");
});

test("an image that cannot be had says so", async ({ page }) => {
  const box = await openCard(page, "![gone](https://pictures.example/missing.png)");
  await box.getByRole("button", { name: "Show the image from pictures.example" }).click();
  await expect(box.getByText("Image unavailable (pictures.example)")).toBeVisible();
});

test("an image too large for a phone is not decoded", async ({ page }) => {
  let box = await openCard(page, `<img src="${pngHeader(20_000, 20_000)}" alt="huge">`);
  await expect(box.getByText("Image too large to show (20000 × 20000 pixels)")).toBeVisible();
  await expect(box.locator("img")).toHaveCount(0);
  await page.getByRole("button", { name: "Start a conversation" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  box = await openCard(page, Array.from({ length: 5 }, () => `<img src="${pngHeader(4_096, 4_096)}">`).join("\n\n"));
  await expect(box.getByText("Image not shown: with the ones before it,")).toBeVisible();
  await expect(box.locator("img")).toHaveCount(4);
  await expect(box.getByRole("button")).toHaveCount(0);
});

test("small print stays readable however deep it nests", async ({ page }) => {
  const nest = (open: string, close: string, count: number, word: string) =>
    `${open.repeat(count)}${word}${close.repeat(count)}`;
  const headings = Array.from({ length: 10 }, (_, i) => `<h1>H${i}<span>`).join("") + "HEND" + "</span></h1>".repeat(10);
  // In a block of its own: in a paragraph, the first heading would close the paragraph and the span.
  const under = `<div><span style="font-size: 32px">${Array.from({ length: 5 }, (_, i) => `<h3>T${i}<span>`).join("")}TEND${"</span></h3>".repeat(5)}</span></div>`;
  const box = await openCard(page, [
    nest("<small>", "</small>", 10, "SMALLDEEP"),
    nest("<sub>", "</sub>", 10, "SUBDEEP"),
    nest("<sup>", "</sup>", 10, "SUPDEEP"),
    nest("<code>", "</code>", 30, "CODEDEEP"),
    '<span style="font-size: 11px"><small>SPANSMALL</small></span>',
    headings,
    under,
    "ABOVE",
    nest("<sup>", "</sup>", 60, "DEEPSUP"),
    nest("<sub>", "</sub>", 60, "DEEPSUB"),
    "BELOW",
  ].join("\n\n"));
  await unfold(page);

  for (const word of ["SMALLDEEP", "SUBDEEP", "SUPDEEP", "CODEDEEP", "SPANSMALL"]) {
    expect(parseFloat(await style(box.getByText(word, { exact: true }), "font-size")), word).toBeGreaterThanOrEqual(11);
  }
  expect(await box.locator("h3 h3").count(), "the headings were not kept nested").toBeGreaterThan(0);
  for (const heading of await box.locator("h3, h4, h5, h6").all()) {
    expect(parseFloat(await style(heading, "font-size"))).toBeLessThanOrEqual(32);
  }

  const outer = await rect(box);
  const above = await rect(box.getByText("ABOVE", { exact: true }));
  const below = await rect(box.getByText("BELOW", { exact: true }));
  const sup = await rect(box.getByText("DEEPSUP", { exact: true }));
  const sub = await rect(box.getByText("DEEPSUB", { exact: true }));
  expect(sup.top).toBeGreaterThanOrEqual(above.bottom - 4);
  expect(sub.bottom).toBeLessThanOrEqual(below.top + 4);
  for (const r of [sup, sub]) {
    expect(r.top).toBeGreaterThanOrEqual(outer.top);
    expect(r.bottom).toBeLessThanOrEqual(outer.bottom);
  }
  const positions = await box.locator("sup, sub").evaluateAll((all) => [...new Set(all.map((e) => getComputedStyle(e).position))]);
  expect(positions).toEqual(["static"]);
});

test("a link that shows one site and leads to another asks first", async ({ page, context }) => {
  const long = `${"a".repeat(3_000)}.example`;
  const box = await openCard(page, [
    "[https://bank.example](https://site.example/b)",
    `[![bank.example](${DOT})](https://site.example/b)`,
    "[Sign in at bank.example](https://site.example/b)",
    "[https://site.example/b](https://site.example/b)",
    "<https://site.example/b>",
    `[bank.example](https://${long}/)`,
  ].join("\n\n"));
  const links = box.locator("a");
  await expect(links).toHaveCount(6);

  const elsewhere = links.nth(0);
  await expect(elsewhere).not.toHaveAttribute("href");
  const question = "This link does not lead to the site its text shows. Open it?";
  await elsewhere.click();
  const asking = page.getByRole("alertdialog", { name: question });
  await expect(asking).toBeVisible();
  expect(question).not.toContain("example");
  await expect(asking.locator("h2")).toHaveText(question);
  await expect(asking.getByText("It leads to site.example")).toBeVisible();
  await expect(asking.getByText("Its text shows bank.example")).toBeVisible();
  await expect(asking.locator("bdi", { hasText: /^site\.example$/ })).toBeVisible();
  await expect(asking.locator("bdi", { hasText: /^bank\.example$/ })).toBeVisible();
  await answer(page, false);
  expect(opened).toEqual([]);

  await elsewhere.click();
  const popup = context.waitForEvent("page");
  await answer(page, true);
  const site = await popup;
  await expect.poll(() => site.url()).toBe("https://site.example/b");
  await site.close();
  opened.length = 0;

  for (const index of [1, 2]) {
    await links.nth(index).click();
    await expect(page.getByRole("alertdialog")).toBeVisible();
    await answer(page, false);
  }

  for (const index of [3, 4]) {
    const honest = links.nth(index);
    await expect(honest).toHaveAttribute("href", "https://site.example/b");
    const next = context.waitForEvent("page");
    await honest.click();
    const tab = await next;
    await expect.poll(() => tab.url()).toBe("https://site.example/b");
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await tab.close();
  }
  opened.length = 0;

  await links.nth(5).click();
  const far = page.getByRole("alertdialog");
  await expect(far).toBeVisible();
  await expect(far.locator("bdi").first()).toHaveText(long);
  expect(await page.evaluate(() => document.scrollingElement!.scrollWidth <= document.scrollingElement!.clientWidth)).toBe(true);
  await answer(page, false);
  expect(opened).toEqual([]);

  // Last: on Windows a middle click starts the browser's autoscroll, which takes the next click.
  await elsewhere.click({ button: "middle" });
  await page.waitForTimeout(500);
  expect(opened, "a middle click opened the link without asking").toEqual([]);
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
});

test("nothing scrolls the page sideways on a phone", async ({ page }) => {
  const long = `${"a".repeat(3_000)}.example`;
  expect(new URL(`https://${long}/a.png`).host.length).toBe(3_008);
  const tenColumns = [
    `| ${Array.from({ length: 10 }, (_, i) => `header${String(i).padStart(2, "0")}`).join(" | ")} |`,
    `|${"---|".repeat(10)}`,
    `| ${Array.from({ length: 10 }, () => "abcdefgh").join(" | ")} |`,
  ].join("\n");
  const alt = "b".repeat(10_000);
  const text = [
    `<table><tr>${Array.from({ length: 30 }, () => "<td>Supercalifragilistic</td>").join("")}</tr></table>`,
    tenColumns,
    "c".repeat(500),
    `<img src="${DOT}" width="2000" alt="broad">`,
    '<div style="width: 2000px; max-width: 3000px">a wide box</div>',
    `<img src="data:image/png;base64,AAAA" alt="${alt}">`,
    `<img src="https://${long}/a.png" alt="far">`,
    Array.from({ length: 1_000 }, (_, i) => `<img src="https://h${i + 1}.example/a.png">`).join(""),
  ].join("\n\n");
  expect(layoutRefusal(text)).toBeNull();
  const box = await openCard(page, text);
  await unfold(page);

  await expect(box.locator('img[alt="broad"]')).toHaveAttribute("width", "2000");
  expect(await page.evaluate(() => document.scrollingElement!.scrollWidth <= document.scrollingElement!.clientWidth)).toBe(true);

  const tables = box.locator(".card-table");
  await expect(tables).toHaveCount(2);
  for (const table of await tables.all()) {
    expect(await table.evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(true);
  }
  for (const cell of await tables.nth(1).locator("td, th").all()) {
    expect((await rect(cell)).width).toBeGreaterThanOrEqual(40);
  }
  const bounds = await inner(box);
  expect((await rect(box.getByText("a wide box", { exact: true }))).width).toBeLessThanOrEqual(bounds.width + 0.5);

  // Drawn on its first 2,000 code points.
  const altText = box.getByText(alt.slice(0, 2_000), { exact: true });
  const place = altText.locator("xpath=ancestor::*[contains(@class, 'card-placeholder')][1]");
  const lineHeight = parseFloat(await style(altText, "line-height"));
  expect((await rect(place)).height).toBeLessThanOrEqual(4 * lineHeight + 44);

  const farPlace = box.locator(".card-placeholder", { hasText: long });
  await expect(farPlace).toHaveCount(1);
  expect((await rect(farPlace)).right).toBeLessThanOrEqual(bounds.right + 0.5);

  const contacts = page.locator("p", { hasText: "Will contact:" });
  const said = (await contacts.textContent()) ?? "";
  expect(said).toContain(`…${long.slice(-32)}`);
  expect(said).toContain("h1.example");
  expect(said).toContain("h2.example");
  expect(said).toContain("and 998 others");
  expect(said).not.toContain(long);
  expect((await rect(contacts)).height).toBeLessThanOrEqual(4 * parseFloat(await style(contacts, "line-height")));
});

test("the text is shown plainly when the layout cannot be loaded, with a way to reload", async ({ page }) => {
  await page.route("**/assets/renderPresentation-*.js", (route) => route.abort());
  const box = await openCard(page, "Some **bold** words.", { plain: true });
  await expect(box.getByText("Some bold words.")).toBeVisible();
  await expect(box.getByText("**bold**")).toHaveCount(0);
  const missing = page.getByText("The layout could not be loaded.");
  await expect(missing).toBeVisible();
  const reload = page.getByRole("button", { name: "Reload" });
  await expect(reload).toBeVisible();
  expect((await rect(reload)).height).toBeGreaterThanOrEqual(43.5);
  expect((await rect(missing)).bottom).toBeLessThanOrEqual((await rect(box)).top);
  expect((await rect(reload)).bottom).toBeLessThanOrEqual((await rect(box)).top);
});

test("the layout comes back with a reload once the link is back", async ({ page }) => {
  await page.route("**/assets/renderPresentation-*.js", (route) => route.abort());
  const box = await openCard(page, "Some **bold** words.", { plain: true });
  await expect(page.getByText("The layout could not be loaded.")).toBeVisible();
  await expect(box.locator("strong")).toHaveCount(0);
  await page.unroute("**/assets/renderPresentation-*.js");
  await page.getByRole("button", { name: "Reload" }).click();
  await expect(box.locator("strong", { hasText: "bold" })).toBeVisible();
  await expect(page.getByText("The layout could not be loaded.")).toHaveCount(0);
});

test("a long presentation folds, and opens on a tap", async ({ page }) => {
  const box = await openCard(page, Array.from({ length: 80 }, (_, i) => `Paragraph ${i + 1}.`).join("\n\n"));
  const more = page.getByRole("button", { name: "Read more" });
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await more.click();
  await expect(page.getByRole("button", { name: "Show less" })).toHaveAttribute("aria-expanded", "true");
  const last = box.getByText("Paragraph 80.", { exact: true });
  await last.scrollIntoViewIfNeeded();
  await expect(last).toBeInViewport();
  const section = box.locator("xpath=ancestor::section[1]");
  for (const button of await section.getByRole("button").all()) {
    expect((await rect(button)).height).toBeGreaterThanOrEqual(43.5);
  }
});

test("a folded presentation opens when the keyboard reaches what it hides, and each Show button names its image", async ({ page }) => {
  const paragraphs = Array.from({ length: 80 }, (_, i) => `Paragraph ${i + 1}.`).join("\n\n");
  await openCard(page, `${paragraphs}\n\n[the site](https://site.example/z)`);
  const more = page.getByRole("button", { name: "Read more" });
  await more.focus();
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("Shift+Tab");
  const link = page.locator('.card-presentation a[href="https://site.example/z"]');
  await expect(link).toBeFocused();
  await expect(page.getByRole("button", { name: "Show less" })).toHaveAttribute("aria-expanded", "true");
  await expect(link).toBeInViewport();

  await openCard(page, `![Map](https://pictures.example/map.png) ![Crest](https://pictures.example/crest.png)\n\n${paragraphs}`);
  const folded = page.getByRole("button", { name: "Read more" });
  await expect(folded).toHaveAttribute("aria-expanded", "false");
  const showAll = page.getByRole("button", { name: "Show images" });
  await showAll.focus();
  await expect(showAll).toBeFocused();
  await expect(folded).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("Tab");
  const shows = page.getByRole("button", { name: "Show the image from pictures.example" });
  await expect(shows.first()).toBeFocused();
  await expect(folded).toHaveAttribute("aria-expanded", "false");

  await expect(shows).toHaveCount(2);
  await expect(shows.nth(0)).toHaveAccessibleDescription("Map");
  await expect(shows.nth(1)).toHaveAccessibleDescription("Crest");
  expect(toPictures()).toEqual([]);
});
