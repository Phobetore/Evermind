/** What went wrong when the server could not do what was asked. `kind` names the failure, which
 *  `describeError` turns into a sentence: the server names its own, and the request layer adds
 *  "http_error", an answer with nothing readable in it, and "network" or "offline", no answer at
 *  all. `resource` is what a "not_found" did not find; `retryAfter`, the seconds the server asked to
 *  wait; `params`, the numbers the sentence for its kind is made of (a bound and a length). When a
 *  model's server failed, the message is what it said, or the address it could not be reached at. */
export class DataError extends Error {
  kind?: string;
  resource?: string;
  status?: number;
  retryAfter?: number;
  params?: Record<string, number>;

  constructor(
    message: string,
    details: {
      kind?: string;
      resource?: string;
      status?: number;
      retryAfter?: number;
      params?: Record<string, number>;
      cause?: unknown;
    } = {},
  ) {
    super(message, "cause" in details ? { cause: details.cause } : undefined);
    this.name = "DataError";
    this.kind = details.kind;
    this.resource = details.resource;
    this.status = details.status;
    this.retryAfter = details.retryAfter;
    this.params = details.params;
  }
}
