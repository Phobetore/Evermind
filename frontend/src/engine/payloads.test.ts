import { expect, test } from "vitest";
import { loreKeyword, pyJsonDumps } from "./payloads";

// What parity/payloads.json cannot say, because a case file is strict JSON and
// cannot tell 1.0 from 1: the numbers that Python's json.dumps writes and
// JSON.stringify does not.
test.each([
  [NaN, "NaN"],
  [Infinity, "Infinity"],
  [-Infinity, "-Infinity"],
])("pyJsonDumps(%j) is what Python writes", (value, text) => {
  expect(pyJsonDumps(value)).toBe(text);
  expect(pyJsonDumps([value])).toBe(`[\n  ${text}\n]`);
});

test("a whole number is written as an integer, up to where JSON.stringify turns to an exponent", () => {
  expect(pyJsonDumps(1e16)).toBe("10000000000000000");
  expect(pyJsonDumps(1e20)).toBe("100000000000000000000");
  expect(pyJsonDumps(-0)).toBe("0");
  expect(pyJsonDumps(1e21)).toBe("1e+21");
  expect(pyJsonDumps(-1e22)).toBe("-1e+22");
});

test("a small or a large float has Python's exponent, with two digits at least", () => {
  expect(pyJsonDumps(1e-7)).toBe("1e-07");
  expect(pyJsonDumps(0.00001)).toBe("1e-05");
  expect(pyJsonDumps(0.0001)).toBe("0.0001");
  expect(pyJsonDumps(1.5e-100)).toBe("1.5e-100");
  expect(pyJsonDumps(1.7976931348623157e308)).toBe("1.7976931348623157e+308");
});

test("anything that is not a number is what JSON.stringify writes", () => {
  const value = {
    a: ["x", true, null, [], {}, [[]], { b: [{}, "\u00e9\u2028\u{1F600}"] }],
    "k\"ey": "line\nbreak \\ \u0001",
  };
  expect(pyJsonDumps(value)).toBe(JSON.stringify(value, null, 2));
});

test("a keyword that is a whole number past 2^53 is not one, where Python counts it", () => {
  expect(loreKeyword(2 ** 53 - 1)).toBe("9007199254740991");
  expect(loreKeyword(-(2 ** 53 - 1))).toBe("-9007199254740991");
  expect(loreKeyword(2 ** 53)).toBe("");
  expect(loreKeyword(1e22)).toBe("");
});
