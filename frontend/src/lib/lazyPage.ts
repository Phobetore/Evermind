import type { ComponentType } from "react";

/** The code of a page could not be fetched. Kept apart from what a page
 *  raises once it is on screen: fetching it again is the cure for the first
 *  and does nothing for the second. */
export class PageLoadError extends Error {
  constructor(cause: unknown) {
    super("The code of a page could not be loaded.", { cause });
    this.name = "PageLoadError";
  }
}

export function isPageLoadError(error: unknown): error is PageLoadError {
  return error instanceof PageLoadError;
}

/** The `lazy` of a route: fetches the module of a page the first time someone
 *  goes there, instead of with the rest of the app. The pages export their
 *  component by name, which the router does not look for. */
export function lazyPage<Name extends string>(
  load: () => Promise<Record<Name, ComponentType>>,
  name: Name,
) {
  return async () => {
    let module: Record<Name, ComponentType>;
    try {
      module = await load();
    } catch (cause) {
      throw new PageLoadError(cause);
    }
    return { Component: module[name] };
  };
}
