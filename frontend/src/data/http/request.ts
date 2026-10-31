import { DataError } from "../errors";

const lockedHandlers = new Set<() => void>();

/** `fetch`, looked up when a call is made and not when this is imported: a page
 *  that replaces it later (to watch or to fake the network) is still heard. */
export const lazyFetch: typeof fetch = (input, init) => fetch(input, init);

/** Run `handler` whenever the server answers that the access password is
 *  needed (a 401 of kind "locked"), which is how a session that has ended
 *  shows up in the middle of a conversation. The call that met the 401 still
 *  rejects afterwards. Returns the function that takes the handler off again. */
export function onLocked(handler: () => void): () => void {
  lockedHandlers.add(handler);
  return () => {
    lockedHandlers.delete(handler);
  };
}

function retryAfterOf(resp: Response): number | undefined {
  const header = resp.headers.get("Retry-After")?.trim();
  if (!header) return undefined;
  // The server counts seconds. A date, which the header also allows, is not
  // something to wait out here, so it counts as no advice.
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

/** Throw the error a failed response stands for. Nothing in the body is
 *  trusted to be there: a proxy in front of the server answers with HTML.
 *  An answer with no sentence in it, and no kind of its own, is an "http_error",
 *  which says nothing but the status. */
async function raiseFor(resp: Response): Promise<never> {
  let message: string | undefined;
  let kind: string | undefined;
  let resource: string | undefined;
  try {
    const body = await resp.json();
    const said = body.error ?? body.detail;
    if (said !== undefined && said !== null && said !== "") {
      message = typeof said === "string" ? said : JSON.stringify(said);
    }
    if (typeof body.kind === "string") kind = body.kind;
    if (typeof body.resource === "string") resource = body.resource;
  } catch {
    /* nothing readable: the status is all there is */
  }
  if (message === undefined) {
    message = `HTTP ${resp.status}`;
    kind ??= "http_error";
  }
  if (resp.status === 401 && kind === "locked") {
    // Each in its own try: a handler that throws must neither stand in for the
    // error below nor stop the ones registered after it from hearing about it.
    // Nothing else is left to hear it, so it goes to the console.
    for (const handler of lockedHandlers) {
      try {
        handler();
      } catch (error) {
        console.error("A handler of onLocked threw:", error);
      }
    }
  }
  throw new DataError(message, {
    kind,
    resource,
    status: resp.status,
    retryAfter: retryAfterOf(resp),
  });
}

/** What a call that got no answer at all is: the browser's own failure, whose
 *  words differ from one browser to the next, becomes a DataError of kind
 *  "network". Giving up on purpose (an abort) is the caller's doing and stays
 *  as it is. */
export function networkFailure(error: unknown): unknown {
  if (error instanceof DataError) return error;
  if ((error as { name?: string } | null)?.name === "AbortError") return error;
  return new DataError("Network error", { kind: "network", cause: error });
}

/** The response to a request, once it is known to have succeeded. */
export async function send(
  path: string,
  init?: RequestInit,
  fetchImpl: typeof fetch = lazyFetch,
): Promise<Response> {
  const headers = new Headers(init?.headers);
  // A multipart body must go out without a content type of its own: the
  // browser adds one that carries the boundary.
  if (typeof init?.body === "string" && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  let resp: Response;
  try {
    resp = await fetchImpl(path, { ...init, headers });
  } catch (error) {
    throw networkFailure(error);
  }
  if (!resp.ok) await raiseFor(resp);
  return resp;
}

export async function request<T>(
  path: string,
  init?: RequestInit,
  fetchImpl?: typeof fetch,
): Promise<T> {
  const resp = await send(path, init, fetchImpl);
  if (resp.status === 204) return undefined as T;
  return resp.json();
}
