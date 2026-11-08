import { DataError } from "../errors";

let lockedHandler = () => {};

/** `fetch`, looked up when a call is made and not when this is imported: a page
 *  that replaces it later (to watch or to fake the network) is still heard. */
export const lazyFetch: typeof fetch = (input, init) => fetch(input, init);

/** Run `handler` whenever the server answers that the access password is
 *  needed (a 401 of kind "locked"), which is how a session that has ended
 *  shows up in the middle of a conversation. The call that met the 401 still
 *  rejects afterwards. */
export const onLocked = (handler: () => void) => {
  lockedHandler = handler;
};

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
  if (resp.status === 401 && kind === "locked") lockedHandler();
  const retryAfter = Number(resp.headers.get("Retry-After")) || undefined;
  throw new DataError(message, { kind, resource, status: resp.status, retryAfter });
}

/** What a call that got no answer at all is: the browser's own failure, whose
 *  words differ from one browser to the next, becomes a DataError of kind
 *  "network", or "offline" when the browser knows it has no network. Giving up
 *  on purpose (an abort) is the caller's doing and stays as it is. */
export function networkFailure(error: unknown): unknown {
  if (error instanceof DataError) return error;
  if ((error as { name?: string } | null)?.name === "AbortError") return error;
  const offline = globalThis.navigator?.onLine === false;
  return new DataError("Network error", { kind: offline ? "offline" : "network", cause: error });
}

/** The response to a request, once it is known to have succeeded; one not begun within `within` ms is unanswered. */
export async function send(
  path: string,
  init?: RequestInit,
  fetchImpl: typeof fetch = lazyFetch,
  within?: number,
): Promise<Response> {
  const headers = new Headers(init?.headers);
  // A multipart body must go out without a content type of its own: the
  // browser adds one that carries the boundary.
  if (typeof init?.body === "string" && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  let signal = init?.signal;
  let late: ReturnType<typeof setTimeout> | undefined;
  if (within !== undefined) {
    const giveUp = new AbortController();
    const asker = init?.signal;
    if (asker?.aborted) giveUp.abort(asker.reason);
    asker?.addEventListener("abort", () => giveUp.abort(asker.reason), { once: true });
    late = setTimeout(() => giveUp.abort(new DataError("No answer in time.", { kind: "network" })), within);
    signal = giveUp.signal;
  }
  let resp: Response;
  try {
    resp = await fetchImpl(path, { ...init, headers, signal });
  } catch (error) {
    throw networkFailure(signal?.reason instanceof DataError ? signal.reason : error);
  } finally {
    clearTimeout(late);
  }
  if (!resp.ok) await raiseFor(resp);
  return resp;
}

export async function request<T>(
  path: string,
  init?: RequestInit,
  fetchImpl?: typeof fetch,
  within?: number,
): Promise<T> {
  const resp = await send(path, init, fetchImpl, within);
  if (resp.status === 204) return undefined as T;
  return resp.json();
}
