import { expect, test } from "vitest";
import { DataError } from "@/data/errors";
import { loginFailure } from "./loginFailure";

test("a wrong password is refused and the field is emptied", () => {
  const error = new DataError("Wrong password.", { kind: "wrong_password", status: 401 });
  expect(loginFailure(error)).toEqual({ key: "login.accessDenied", clearPassword: true });
});

test.each([
  [90, 2], [60, 1], [1, 1], [0, 1], [901, 16], [undefined, 1],
])("too many attempts, retry after %j s, says %j min", (retryAfter, minutes) => {
  const error = new DataError("Too many attempts.", { kind: "rate_limited", status: 429, retryAfter });
  expect(loginFailure(error)).toEqual({
    key: "login.tooManyAttempts",
    vars: { minutes },
    clearPassword: false,
  });
});

// What a proxy in front of the server says when it cannot reach it comes out
// of the request layer as "Erreur 502": not something to show anyone.
test.each([500, 502, 503, 504])("a %i from anywhere is the server being out of reach", (status) => {
  const error = new DataError(`Erreur ${status}`, { status });
  expect(loginFailure(error)).toEqual({ key: "login.serverUnreachable", clearPassword: false });
});

test("an answer that is not the server's own is the server being out of reach", () => {
  expect(loginFailure(new DataError("Erreur 404", { status: 404 })).key).toBe("login.serverUnreachable");
  expect(loginFailure(new DataError("Erreur 502", { kind: "something_else", status: 502 })).key).toBe(
    "login.serverUnreachable",
  );
});

test("a call that never got an answer is the server being out of reach", () => {
  expect(loginFailure(new TypeError("Failed to fetch"))).toEqual({
    key: "login.serverUnreachable",
    clearPassword: false,
  });
});
