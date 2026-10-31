/** What went wrong when the server could not do what was asked.
 *
 *  `kind` is a name for the failure, which `describeError` turns into a
 *  sentence in the person's language. The server names its own ("not_found",
 *  "unreachable" for a model that never answered...); the request layer adds
 *  two for what it sees without the server's help: "http_error", an answer
 *  with nothing readable in it, and "network", no answer at all. `resource` is
 *  what a "not_found" did not find. `status` is the HTTP status, and
 *  `retryAfter` is how many seconds to wait before trying again when the
 *  server said so (a rate limit does). */
export class DataError extends Error {
  kind?: string;
  resource?: string;
  status?: number;
  retryAfter?: number;

  constructor(
    message: string,
    details: {
      kind?: string;
      resource?: string;
      status?: number;
      retryAfter?: number;
      cause?: unknown;
    } = {},
  ) {
    super(message, "cause" in details ? { cause: details.cause } : undefined);
    this.name = "DataError";
    this.kind = details.kind;
    this.resource = details.resource;
    this.status = details.status;
    this.retryAfter = details.retryAfter;
  }
}
