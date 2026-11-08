import { expect, type Page } from "@playwright/test";
import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * What a phone going to sleep does to a reply being read: the request rejects part
 * way through the answer, and the server, whose turn it is, carries on. Routing
 * cannot produce that (fulfilling a route always ends the body cleanly, and
 * offline mode leaves an established connection alone), so it is `fetch` in the
 * page that is replaced, for the first request to `path`.
 *
 * After `chunks` chunks of the answer it fails, or when the test calls
 * `window.__cutConnection()` if there is no such number. With `staysDead`, nothing
 * gets through afterwards until `window.__connectionBack()`. With `hangs` it fails
 * in another way a stream can: no error, no end, just nothing more. With `closes`,
 * in the third: it ends cleanly, as when something in between gives up on it.
 * Aborting it works as it does on a real one.
 */
type ConnectionTrouble = { chunks?: number; staysDead?: boolean; hangs?: boolean; closes?: boolean };

export async function connectionDiesDuring(page: Page, path: string, trouble: ConnectionTrouble = {}) {
  const options = {
    chunks: null as number | null, staysDead: false, hangs: false, closes: false, ...trouble,
  };
  await page.addInitScript(({ path, chunks, staysDead, hangs, closes }) => {
    const realFetch = window.fetch;
    const page_ = window as unknown as Record<string, () => void>;
    let cut = false;
    let dead = false;
    let cutNow = () => {};
    const asked = new Promise<"cut">((resolve) => { cutNow = () => resolve("cut"); });
    page_.__cutConnection = () => cutNow();
    page_.__connectionBack = () => { dead = false; };
    window.fetch = async (input, init) => {
      if (dead) throw new TypeError("Failed to fetch");
      const response = await realFetch(input, init);
      if (cut || !String(input).endsWith(path) || !response.body) return response;
      cut = true;
      const reader = response.body.getReader();
      let passed = 0;
      const body = new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener("abort", () => {
            try {
              controller.error(new DOMException("Aborted", "AbortError"));
            } catch {
              /* it had already ended */
            }
          });
        },
        async pull(controller) {
          const next = chunks !== null && passed++ >= chunks
            ? "cut" as const
            : await Promise.race([reader.read(), asked]);
          if (next !== "cut") {
            if (next.done) controller.close();
            else controller.enqueue(next.value);
            return;
          }
          if (hangs) return new Promise<void>(() => {});
          dead = staysDead;
          await reader.cancel();
          if (closes) controller.close();
          else controller.error(new TypeError("network error"));
        },
      });
      return new Response(body, { status: response.status, headers: response.headers });
    };
  }, { path, ...options });
}

export async function connectionBack(page: Page) {
  await page.evaluate(() => (window as unknown as Record<string, () => void>).__connectionBack());
}

export async function cutConnection(page: Page) {
  await page.evaluate(() => (window as unknown as Record<string, () => void>).__cutConnection());
}

/**
 * The home Wi-Fi, as a proxy between the browser and Evermind: it can lose the answer to a
 * request while keeping its connection open. Unlike a route, it leaves the browser's cache on,
 * where a request to the same address can wait behind the one left hanging.
 */
export async function homeWifi() {
  const losing = new Set<string>();
  const proxy = http.createServer((asked, answer) => {
    const url = new URL(asked.url!);
    const passed = http.request(url, { method: asked.method, headers: asked.headers }, (served) => {
      if (asked.method === "GET" && losing.delete(url.pathname)) return void served.resume();
      answer.writeHead(served.statusCode!, served.headers);
      served.pipe(answer);
    });
    passed.on("error", () => answer.destroy());
    answer.on("close", () => passed.destroy());
    asked.pipe(passed);
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  return {
    server: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`,
    /** The answer to the next GET of this path is lost on the way back. */
    loseAnswerTo: (path: string) => losing.add(path),
    close: () => new Promise<void>((resolve) => {
      proxy.closeAllConnections();
      proxy.close(() => resolve());
    }),
  };
}

/** Says what a phone coming back says. The page waits a moment before acting on it. */
export async function phoneComesBack(page: Page) {
  await page.evaluate(() => {
    window.dispatchEvent(new Event("online"));
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

/** Goes somewhere within the page, without loading anything: what a link does. */
export async function goWithinThePage(page: Page, route: string) {
  await page.evaluate((hash) => { location.hash = hash; }, route);
}

export const stopButton = (page: Page) => page.locator('button[title="Stop generation"]');
export const retryButton = (page: Page) => page.getByRole("button", { name: "Retry" });
export const report = (page: Page) => page.locator("p.text-blood");
/** The words of a reply outside the messages: arriving, or kept after being cut off. */
export const looseWords = (page: Page) => page.locator("main .rp-prose:not([data-message-id] .rp-prose)");
export const writing = (page: Page) => page.locator(".stream-caret");

export const endingOf = (content: string) =>
  content.trim().split(" ").slice(-3).join(" ").replaceAll("*", "");

function countingRequests(page: Page, ending: string) {
  let count = 0;
  page.on("request", (sent) => {
    if (new URL(sent.url()).pathname.endsWith(ending)) count += 1;
  });
  return () => count;
}

/** How many times the page has started reading a turn's stream. */
export const countingStreams = (page: Page) => countingRequests(page, "/turn/stream");
/** How many times the page has asked for a turn. */
export const countingPosts = (page: Page) => countingRequests(page, "/api/chat");

/** The stream has been read again, and more words than it had are arriving. */
export async function expectPickedUp(page: Page, pickedUp: Promise<unknown>) {
  await pickedUp;
  await expect(stopButton(page), "nothing to stop the reply with").toBeVisible();
  await expect(writing(page)).toBeVisible();
  await expect(writing(page)).not.toHaveText((await writing(page).textContent()) ?? "");
  await expect(stopButton(page), "nothing to stop the reply with").toBeVisible();
  await expect(report(page), "a lost connection was reported as a failure").toHaveCount(0);
}
