import { describe, expect, test } from "vitest";
import { cssUrl } from "./utils";

describe("cssUrl", () => {
  test("an address with parentheses, an apostrophe and quotes stays one string", () => {
    expect(cssUrl('a (1)\'s "x".png')).toBe('url("a (1)\'s \\"x\\".png")');
  });

  test("an inline image comes out whole, between quotes", () => {
    expect(cssUrl("data:image/webp;base64,AAAA")).toBe('url("data:image/webp;base64,AAAA")');
  });

  test("a backslash is escaped and a line break is dropped", () => {
    expect(cssUrl("a\\b\r\nc\nd")).toBe('url("a\\\\bcd")');
  });
});
