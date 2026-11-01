import type { ComponentType, ErrorInfo } from "react";

/** The code of a page could not be fetched. Kept apart from what a page
 *  raises once it is on screen: fetching it again is the cure for the first,
 *  and no sure cure for the second. */
export class PageLoadError extends Error {
  constructor(cause: unknown) {
    super("The code of a page could not be loaded.", { cause });
    this.name = "PageLoadError";
  }
}

export function isPageLoadError(error: unknown): error is PageLoadError {
  return error instanceof PageLoadError;
}

/** How the browsers (and Vite, for a style sheet) say that a module could not
 *  be fetched. The wording is theirs and differs from one to the next; a
 *  module that fails as it runs says something of its own instead. */
const FETCH_FAILED = [
  /failed to fetch dynamically imported module/i, // Chromium
  /error loading dynamically imported module/i, // Firefox
  /importing a module script failed/i, // Safari
  /unable to preload css/i, // Vite
];

/** The address of a script, as the error of a fetch that names the file it
 *  could not get does. */
const SCRIPT_ADDRESS = /\bhttps?:\/\/\S+\.m?js\b|\/assets\/\S+\.m?js\b/;

function fetchFailed(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (FETCH_FAILED.some((words) => words.test(error.message))) return true;
  return error instanceof TypeError && SCRIPT_ADDRESS.test(error.message);
}

/** The `lazy` of a route: fetches the module of a page the first time someone
 *  goes there, instead of with the rest of the app. The pages export their
 *  component by name, which the router does not look for.
 *
 *  Only a module that could not be fetched becomes a `PageLoadError`. One that
 *  was fetched and failed as it ran is the page's own fault: it goes on as it
 *  is, since loading the page again may well fail the same way. */
export function lazyPage<Name extends string>(
  load: () => Promise<Record<Name, ComponentType>>,
  name: Name,
) {
  return async () => {
    let module: Record<Name, ComponentType>;
    try {
      module = await load();
    } catch (error) {
      throw fetchFailed(error) ? new PageLoadError(error) : error;
    }
    return { Component: module[name] };
  };
}

/** The router's `onError`: it hears of every error the router meets, and the
 *  console is where whoever runs Evermind looks.
 *
 *  An error caught while a page is drawn comes with `errorInfo`, and React 19
 *  reports those itself (`onCaughtError`): logging them here as well would show
 *  every such fault twice. The others, which nothing else reports, are what
 *  this is for: the fetch of a page failing, or the page's file failing as it
 *  runs. */
export function logRouteError(error: unknown, info?: { errorInfo?: ErrorInfo }) {
  if (info?.errorInfo) return;
  if (isPageLoadError(error)) {
    console.error("The code of a page could not be loaded:", error.cause);
  } else {
    console.error(error);
  }
}
