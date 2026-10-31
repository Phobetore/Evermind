/** What went wrong when the server could not do what was asked.
 *
 *  `kind` is a name the server gave the failure, for the places where the
 *  interface has something better to show than the sentence: "unreachable" is a
 *  model that never answered, which is not a mistake anyone made. `status` is
 *  the HTTP status, and `retryAfter` is how many seconds to wait before trying
 *  again when the server said so (a rate limit does). */
export class DataError extends Error {
  kind?: string;
  status?: number;
  retryAfter?: number;

  constructor(
    message: string,
    details: { kind?: string; status?: number; retryAfter?: number } = {},
  ) {
    super(message);
    this.name = "DataError";
    this.kind = details.kind;
    this.status = details.status;
    this.retryAfter = details.retryAfter;
  }
}
