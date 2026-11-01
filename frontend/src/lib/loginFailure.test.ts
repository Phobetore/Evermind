import { expect, test } from "vitest";
import { DataError } from "@/data/errors";
import { loginFailure } from "./loginFailure";

const t = (key: string, vars?: Record<string, string | number>) =>
  vars ? `${key} ${JSON.stringify(vars)}` : key;

test("a wrong password is refused and the field is emptied", () => {
  const error = new DataError("Wrong password.", { kind: "wrong_password", status: 401 });
  expect(loginFailure(error, t)).toEqual({ message: "errors.wrongPassword", clearPassword: true });
});

test.each([
  [90, 2], [60, 1], [1, 1], [0, 1], [901, 16], [undefined, 1],
])("too many attempts, retry after %j s, says %j min", (retryAfter, minutes) => {
  const error = new DataError("Too many attempts.", { kind: "rate_limited", status: 429, retryAfter });
  expect(loginFailure(error, t)).toEqual({
    message: `errors.rateLimited {"minutes":${minutes}}`,
    clearPassword: false,
  });
});

// What a proxy in front of the server says when it cannot reach it comes out
// of the request layer as an HTTP error with nothing but its status.
test.each([500, 502, 503, 504])("a %i from anywhere says so and keeps the password", (status) => {
  const error = new DataError(`HTTP ${status}`, { kind: "http_error", status });
  expect(loginFailure(error, t)).toEqual({
    message: `errors.server {"status":${status}}`,
    clearPassword: false,
  });
});

test("a call that never got an answer is Evermind not answering", () => {
  const error = new DataError("Network error", { kind: "network" });
  expect(loginFailure(error, t)).toEqual({ message: "errors.unreachable", clearPassword: false });
});

test("a refusal of the request itself is named, not passed off as the server being down", () => {
  const error = new DataError("Cross-origin request refused.", { kind: "cross_origin", status: 403 });
  expect(loginFailure(error, t)).toEqual({ message: "errors.crossOrigin", clearPassword: false });
});

test("anything that is not an error of the data layer keeps the password too", () => {
  expect(loginFailure(new TypeError("x is undefined"), t)).toEqual({
    message: "errors.unexpected",
    clearPassword: false,
  });
});
