import { DataError } from "@/data/errors";

/** What the login page says about an attempt that failed: the key of the
 *  message, the values it needs, and whether the password typed is spent. */
export type LoginFailure = {
  key: string;
  vars?: { minutes: number };
  clearPassword: boolean;
};

/** Turn what went wrong into something to tell the person at the login.
 *
 *  The server answers a login in only two ways of its own, a wrong password
 *  and too many attempts, and both name themselves with a `kind`. Anything
 *  else did not come from it: a proxy in front of it that answers a 502 with a
 *  page of its own, a connection that dropped. The words such an answer carries
 *  are the transport's, not something to put in front of a person, so they all
 *  come out as the server being out of reach. */
export function loginFailure(error: unknown): LoginFailure {
  if (error instanceof DataError && error.kind === "wrong_password") {
    return { key: "login.accessDenied", clearPassword: true };
  }
  if (error instanceof DataError && error.kind === "rate_limited") {
    // The server says how long in seconds; a minute is what people read.
    const minutes = Math.max(1, Math.ceil((error.retryAfter ?? 60) / 60));
    return { key: "login.tooManyAttempts", vars: { minutes }, clearPassword: false };
  }
  return { key: "login.serverUnreachable", clearPassword: false };
}
