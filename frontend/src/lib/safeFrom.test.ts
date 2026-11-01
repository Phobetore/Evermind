import { expect, test } from "vitest";
import { safeFrom } from "./safeFrom";

// Where the login sends someone once the password is accepted. Only a path
// inside the app may come out: "//evil.example" and "/\evil.example" are
// addresses on another site to a browser, even though they start with a slash.
test.each([
  [null, "/"], ["", "/"], ["/chat/abc", "/chat/abc"], ["/settings?tab=x", "/settings?tab=x"],
  ["//evil.example", "/"], ["https://evil.example", "/"], ["/\\evil.example", "/"],
  ["javascript:alert(1)", "/"], ["chat/abc", "/"],
])("safeFrom(%j) -> %j", (input, expected) => expect(safeFrom(input)).toBe(expected));
