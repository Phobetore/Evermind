import { DataError } from "../errors";
import type { Asking } from "../types";

let lockedHandler = () => {};

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
  let params: Record<string, number> | undefined;
  try {
    const body = await resp.json();
    const said = body.error ?? body.detail;
    if (said !== undefined && said !== null && said !== "") {
      message = typeof said === "string" ? said : JSON.stringify(said);
    }
    if (typeof body.kind === "string") kind = body.kind;
    if (typeof body.resource === "string") resource = body.resource;
    if (body.params && typeof body.params === "object") {
      // Only numbers: they go into a sentence, and anything else would show as it was sent.
      const numbers = Object.entries(body.params).filter(([, v]) => typeof v === "number" && Number.isFinite(v));
      if (numbers.length > 0) params = Object.fromEntries(numbers) as Record<string, number>;
    }
  } catch {
    /* nothing readable: the status is all there is */
  }
  if (message === undefined) {
    message = `HTTP ${resp.status}`;
    kind ??= "http_error";
  }
  if (resp.status === 401 && kind === "locked") lockedHandler();
  const retryAfter = Number(resp.headers.get("Retry-After")) || undefined;
  throw new DataError(message, { kind, resource, status: resp.status, retryAfter, params });
}

/** What a call that got no answer at all is: the browser's own failure, whose
 *  words differ from one browser to the next, becomes a DataError of kind
 *  "network", or "offline" when the browser knows it has no network. Giving up
 *  on purpose (an abort) is the caller's doing and stays as it is. */
export function networkFailure(error: unknown): unknown {
  if ((error as { name?: string } | null)?.name === "AbortError") return error;
  const offline = globalThis.navigator?.onLine === false;
  return new DataError("Network error", { kind: offline ? "offline" : "network", cause: error });
}

/** The response to a request, once it is known to have succeeded; one not begun within `within` ms is unanswered. */
export async function send(path: string, init: RequestInit = {}, { signal, within }: Asking = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  // A multipart body must go out without a content type of its own: the
  // browser adds one that carries the boundary.
  if (typeof init.body === "string" && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  let late: ReturnType<typeof setTimeout> | undefined;
  if (within !== undefined) {
    const giveUp = new AbortController();
    const asker = signal;
    if (asker?.aborted) giveUp.abort(asker.reason);
    asker?.addEventListener("abort", () => giveUp.abort(asker.reason), { once: true });
    late = setTimeout(() => giveUp.abort(new DataError("No answer in time.", { kind: "network" })), within);
    signal = giveUp.signal;
  }
  let resp: Response;
  try {
    resp = await fetch(path, { ...init, headers, signal });
  } catch (error) {
    throw signal?.reason instanceof DataError ? signal.reason : networkFailure(error);
  } finally {
    clearTimeout(late);
  }
  if (!resp.ok) await raiseFor(resp);
  return resp;
}

export async function request<T>(path: string, init?: RequestInit, asking?: Asking): Promise<T> {
  const resp = await send(path, init, asking);
  if (resp.status === 204) return undefined as T;
  return resp.json();
}
