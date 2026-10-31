import { describe, expect, test } from "vitest";
import { isPageLoadError, lazyPage } from "./lazyPage";

describe("lazyPage", () => {
  test("hands the router the component the module exports under that name", async () => {
    const Home = () => null;
    expect(await lazyPage(async () => ({ Home }), "Home")()).toEqual({ Component: Home });
  });

  test("does not fetch anything until the router asks", () => {
    let fetched = false;
    lazyPage(async () => {
      fetched = true;
      return { Home: () => null };
    }, "Home");
    expect(fetched).toBe(false);
  });

  test("a module that cannot be fetched is told apart from other errors, with its cause kept", async () => {
    const cause = new TypeError("Failed to fetch dynamically imported module");
    const error = await lazyPage(() => Promise.reject(cause), "Home")().catch((e: unknown) => e);
    expect(isPageLoadError(error)).toBe(true);
    expect((error as Error).cause).toBe(cause);
  });

  test("an error raised by a page is not a failed load", () => {
    expect(isPageLoadError(new TypeError("Cannot read properties of undefined"))).toBe(false);
    expect(isPageLoadError("Failed to fetch dynamically imported module")).toBe(false);
    expect(isPageLoadError(undefined)).toBe(false);
  });
});
