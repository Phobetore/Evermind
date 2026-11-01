import { DataError } from "@/data/errors";
import type { Translate } from "@/i18n/I18nProvider";
import { describeError } from "./errors";

/** What the login page says about an attempt that failed, and whether the
 *  password typed is spent. */
export type LoginFailure = {
  message: string;
  clearPassword: boolean;
};

/** Turn what went wrong into something to tell the person at the login.
 *
 *  The words are the same as anywhere else in the interface: a wrong password
 *  and too many attempts are kinds like the rest, and so is a proxy in front of
 *  the server answering with a page of its own. What is particular to the login
 *  is the field: a wrong password empties it, and any other failure leaves the
 *  password as typed, to be sent again. */
export function loginFailure(error: unknown, t: Translate): LoginFailure {
  return {
    message: describeError(error, t),
    clearPassword: error instanceof DataError && error.kind === "wrong_password",
  };
}
