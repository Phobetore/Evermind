import { describe, expect, test } from "vitest";
import { parseLlmJson, rawDecode } from "./llmJson";

// What parity/llm_json.json cannot say: a case file is strict JSON, so it holds
// no NaN, no lone surrogate, no number that Python and JavaScript write otherwise,
// and nothing as large as these. backend/tests/test_llm_json.py says the same
// things of the Python.

const read = (text: string) => parseLlmJson(text) as Record<string, unknown>;

describe("what a reply nests too deep to follow", () => {
  const depth = 100_000;

  test("is hopeless, not a crash", () => {
    expect(parseLlmJson("[".repeat(depth))).toBeNull();
    expect(parseLlmJson("[".repeat(depth) + "]".repeat(depth))).toBeNull();
    expect(parseLlmJson('{"a":'.repeat(depth) + "1" + "}".repeat(depth))).toBeNull();
    expect(parseLlmJson('{"a":' + "[".repeat(depth) + "]".repeat(depth) + "}")).toBeNull();
  });

  test("leaves an object that comes before or after it", () => {
    expect(parseLlmJson("[".repeat(depth) + ' {"a": 1}')).toEqual({ a: 1 });
    expect(parseLlmJson('{"a": 1} ' + "[".repeat(depth))).toEqual({ a: 1 });
  });
});

describe("the numbers JSON has no word for", () => {
  test("NaN and the infinities are read", () => {
    const parsed = read('{"a": NaN, "b": Infinity, "c": -Infinity, "d": [NaN, -Infinity]}');
    expect(parsed.a).toBeNaN();
    expect(parsed.b).toBe(Infinity);
    expect(parsed.c).toBe(-Infinity);
    expect(parsed.d).toEqual([NaN, -Infinity]);
  });

  test.each(["nan", "NAN", "infinity", "-NaN", "+Infinity", "Inf", "-inf", "- Infinity", "Infinit"])(
    "%s is not one of them",
    (word) => {
      expect(parseLlmJson(`{"a": ${word}}`)).toBeNull();
    },
  );

  test("an exponent too large for a double is infinite, as it is in Python", () => {
    expect(read('{"a": 1e400, "b": -1e400}')).toEqual({ a: Infinity, b: -Infinity });
  });

  test("an integer of 4300 digits is read, and of 4301 is refused", () => {
    // Python 3.11 and later refuse to turn more digits into an integer.
    expect(parseLlmJson(`{"a": ${"1".repeat(4300)}}`)).not.toBeNull();
    expect(parseLlmJson(`{"a": -${"1".repeat(4300)}}`)).not.toBeNull();
    expect(parseLlmJson(`{"a": ${"1".repeat(4301)}}`)).toBeNull();
    expect(parseLlmJson(`{"a": -${"1".repeat(4301)}}`)).toBeNull();
    // Not an integer: no limit.
    expect(parseLlmJson(`{"a": ${"1".repeat(5000)}.5}`)).not.toBeNull();
    expect(parseLlmJson(`{"a": ${"1".repeat(5000)}e1}`)).not.toBeNull();
  });

  test("an integer has no minus zero, a float has", () => {
    expect(Object.is(read('{"a": -0}').a, 0)).toBe(true);
    expect(Object.is(read('{"a": -0.0}').a, -0)).toBe(true);
    expect(Object.is(read('{"a": -0e1}').a, -0)).toBe(true);
    expect(Object.is(read('{"a": 0}').a, 0)).toBe(true);
  });
});

describe("the characters of a string", () => {
  test("a surrogate pair is one character, a lone surrogate stays as it is", () => {
    expect(read('{"a": "\\ud83d\\ude00"}').a).toBe("\u{1F600}");
    expect(read('{"a": "\\ud83d"}').a).toBe("\ud83d");
    expect(read('{"a": "\\ude00"}').a).toBe("\ude00");
    expect(read('{"a": "\\ud83d\\u0041"}').a).toBe("\ud83dA");
    expect(read('{"a": "\\ud83dA"}').a).toBe("\ud83dA");
    expect(read('{"a": "\\ud83d\\ud83d\\ude00"}').a).toBe("\ud83d\u{1F600}");
    expect(read('{"a": "\\ud83d\\ud83d"}').a).toBe("\ud83d\ud83d");
  });

  test("a surrogate pair is still one character in a key", () => {
    expect(Object.keys(read('{"\\ud83d\\ude00": 1}'))).toEqual(["\u{1F600}"]);
  });

  test("a low surrogate first, then a high one, are two", () => {
    expect(read('{"a": "\\ude00\\ud83d"}').a).toBe("\ude00\ud83d");
  });

  test("a high surrogate followed by an escape that is not hexadecimal is an error", () => {
    expect(parseLlmJson('{"a": "\\ud83d\\u00g0"}')).toBeNull();
    expect(parseLlmJson('{"a": "\\ud83d\\u+123"}')).toBeNull();
    expect(parseLlmJson('{"a": "\\ud83d\\u 123"}')).toBeNull();
  });

  test("the four digits are hexadecimal and nothing else", () => {
    // What Number() and parseInt() would take for one, and Arabic-Indic digits.
    for (const digits of ["0x41", "+041", "-041", " 041", "04 1", "4.1e", "00_1", "\u0660\u0660\u0664\u0661"]) {
      expect(parseLlmJson(`{"a": "\\u${digits}"}`)).toBeNull();
    }
    expect(read('{"a": "\\u00Ab\\u00aB"}').a).toBe("\u00ab\u00ab");
  });

  test("control characters are refused inside a string, and DEL is not one", () => {
    for (let code = 0; code < 0x20; code++) {
      expect(rawDecode(`"x${String.fromCharCode(code)}y"`), `U+${code}`).toBeNull();
    }
    expect(rawDecode('"x\x7fy"')).toEqual({ value: "x\x7fy", end: 5 });
    // The repair writes a line feed, a carriage return and a tab as escapes; no other.
    for (const code of [0x09, 0x0a, 0x0d]) {
      expect(parseLlmJson(`{"a": "x${String.fromCharCode(code)}y"}`)).not.toBeNull();
    }
    for (const code of [0x00, 0x08, 0x0b, 0x0c, 0x1f]) {
      expect(parseLlmJson(`{"a": "x${String.fromCharCode(code)}y"}`)).toBeNull();
    }
  });

  test("a string with a line feed in it is read once repaired", () => {
    expect(read('{"a": "x\ny"}').a).toBe("x\ny");
    expect(read('{"a": "x\ry\tz"}').a).toBe("x\ry\tz");
  });
});

describe("the keys of an object", () => {
  test("__proto__ is a key like any other", () => {
    const parsed = read('{"__proto__": {"polluted": true}, "a": 1}');
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    expect(Object.hasOwn(parsed, "__proto__")).toBe(true);
    expect(Object.keys(parsed)).toEqual(["__proto__", "a"]);
    expect(parsed.polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(parsed).toEqual(JSON.parse('{"__proto__": {"polluted": true}, "a": 1}'));
  });

  test("__proto__ twice, with values of two kinds", () => {
    const parsed = read('{"__proto__": 5, "__proto__": [1], "a": {"__proto__": null}}');
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    expect(parsed.__proto__).toEqual([1]);
    expect(Object.hasOwn(parsed.a as object, "__proto__")).toBe(true);
  });
});

describe("rawDecode", () => {
  test("reads the one value at the start and says where it ends", () => {
    expect(rawDecode('{"a": 1} then more')).toEqual({ value: { a: 1 }, end: 8 });
    expect(rawDecode("xx[1, 2] y", 2)).toEqual({ value: [1, 2], end: 8 });
    expect(rawDecode('"text" and')).toEqual({ value: "text", end: 6 });
    expect(rawDecode("12 3")).toEqual({ value: 12, end: 2 });
    expect(rawDecode("null")).toEqual({ value: null, end: 4 });
    expect(rawDecode("true!")).toEqual({ value: true, end: 4 });
    expect(rawDecode("false")).toEqual({ value: false, end: 5 });
  });

  test("does not skip whitespace before the value", () => {
    expect(rawDecode(" 1")).toBeNull();
    expect(rawDecode(" 1", 1)).toEqual({ value: 1, end: 2 });
  });

  test("is null where Python raises", () => {
    for (const text of ["", "x", "{", "[", '"', '{"a"', '{"a":', '{"a": 1,', "[1,", "[1 2]", "-", "nul"]) {
      expect(rawDecode(text), JSON.stringify(text)).toBeNull();
    }
    expect(rawDecode("[1]", 3)).toBeNull();
    expect(rawDecode("[1]", 99)).toBeNull();
  });

  test("a literal ends where the word does, whatever follows", () => {
    expect(rawDecode("nullx")).toEqual({ value: null, end: 4 });
    expect(rawDecode("truex")).toEqual({ value: true, end: 4 });
    expect(parseLlmJson('{"a": nullx}')).toBeNull();
  });

  test("a number ends where the grammar does", () => {
    expect(rawDecode("1.")).toEqual({ value: 1, end: 1 });
    expect(rawDecode("1e")).toEqual({ value: 1, end: 1 });
    expect(rawDecode("1e+")).toEqual({ value: 1, end: 1 });
    expect(rawDecode("1.5e3x")).toEqual({ value: 1500, end: 5 });
    expect(rawDecode("01")).toEqual({ value: 0, end: 1 });
    expect(rawDecode("-5-")).toEqual({ value: -5, end: 2 });
    expect(rawDecode("2E-2")).toEqual({ value: 0.02, end: 4 });
  });
});
