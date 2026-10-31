import { DataError } from "../errors";

const lockedHandlers = new Set<() => void>();

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
 *  trusted to be there: a proxy in front of the server answers with HTML. */
export async function raiseFor(resp: Response): Promise<never> {
  let message = `Erreur ${resp.status}`;
  let kind: string | undefined;
  try {
    const body = await resp.json();
    message = body.error ?? body.detail ?? message;
    kind = body.kind;
    if (typeof message !== "string") message = JSON.stringify(message);
  } catch {
    /* keep the default */
  }
  if (resp.status === 401 && kind === "locked") lockedHandlers.forEach((handler) => handler());
  throw new DataError(message, { kind, status: resp.status, retryAfter: retryAfterOf(resp) });
}

/** The response to a request, once it is known to have succeeded. */
export async function send(
  path: string,
  init?: RequestInit,
  fetchImpl: typeof fetch = (input, options) => fetch(input, options),
): Promise<Response> {
  const headers = new Headers(init?.headers);
  // A multipart body must go out without a content type of its own: the
  // browser adds one that carries the boundary.
  if (typeof init?.body === "string" && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const resp = await fetchImpl(path, { ...init, headers });
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
