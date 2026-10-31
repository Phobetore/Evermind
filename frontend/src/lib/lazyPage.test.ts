import { afterEach, describe, expect, test, vi } from "vitest";
import { isPageLoadError, lazyPage, logRouteError, PageLoadError } from "./lazyPage";

/** What the router gets when the module of a page is asked for and fails with
 *  `error`. */
const fails = (error: unknown) => lazyPage(() => Promise.reject(error), "Home")().catch((e: unknown) => e);

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

  test.each([
    ["Chromium", new TypeError("Failed to fetch dynamically imported module: http://localhost:3000/assets/Home-1.js")],
    ["Firefox", new TypeError("error loading dynamically imported module: http://localhost:3000/assets/Home-1.js")],
    ["Safari", new TypeError("Importing a module script failed.")],
    ["Vite, for the style sheet of a page", new Error("Unable to preload CSS for /assets/Home-1.css")],
    ["any TypeError that names the script", new TypeError("NetworkError for http://192.168.1.4:3000/assets/Home-1.js")],
  ])("a module that cannot be fetched (%s) is a page load error, with its cause kept", async (_browser, cause) => {
    const error = await fails(cause);
    expect(isPageLoadError(error)).toBe(true);
    expect((error as PageLoadError).cause).toBe(cause);
  });

  test.each([
    ["a TypeError raised as the module runs", new TypeError("Cannot read properties of undefined (reading 'x')")],
    ["a ReferenceError", new ReferenceError("config is not defined")],
    ["an Error that only mentions loading", new Error("Failed to load the configuration")],
    ["an Error that mentions a module without being the fetch", new Error("The module could not be initialised")],
    ["a TypeError worded as no browser we know words a failed fetch", new TypeError("Load failed")],
    ["something that is not an Error", "Failed to fetch dynamically imported module"],
  ])("%s is the page's own fault and passes through as it is", async (_what, cause) => {
    const error = await fails(cause);
    expect(error).toBe(cause);
    expect(isPageLoadError(error)).toBe(false);
  });
});

describe("isPageLoadError", () => {
  test("is true for a failed load only", () => {
    expect(isPageLoadError(new PageLoadError(new TypeError("x")))).toBe(true);
    expect(isPageLoadError(new TypeError("Failed to fetch dynamically imported module"))).toBe(false);
    expect(isPageLoadError(undefined)).toBe(false);
  });
});

describe("logRouteError", () => {
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  afterEach(() => logged.mockClear());

  test("a failed load is logged with the browser's own words", () => {
    const cause = new TypeError("Failed to fetch dynamically imported module: /assets/Home-1.js");
    logRouteError(new PageLoadError(cause));
    expect(logged).toHaveBeenCalledWith("The code of a page could not be loaded:", cause);
  });

  test("anything else is logged as it is", () => {
    const error = new TypeError("Cannot read properties of undefined");
    logRouteError(error);
    expect(logged).toHaveBeenCalledWith(error);
  });

  test("a page that broke as it was drawn is left to React, which reports it itself", () => {
    // The router passes what React knows of the component tree along only for
    // an error caught while drawing, and React 19 logs that one already.
    logRouteError(new TypeError("Cannot read properties of undefined"), { errorInfo: { componentStack: "" } });
    expect(logged).not.toHaveBeenCalled();
  });

  test("what the router reports without a component stack is logged: nothing else does", () => {
    // Nothing was being drawn when the fetch of a page failed.
    const cause = new TypeError("Failed to fetch dynamically imported module");
    logRouteError(new PageLoadError(cause), {});
    expect(logged).toHaveBeenCalledWith("The code of a page could not be loaded:", cause);
  });
});
