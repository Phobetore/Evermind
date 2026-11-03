// Tolerant reading of what a model answers, a copy of backend/app/services/llm_json.py:
// the cases of parity/llm_json.json fail when a single reply is read otherwise.
//
// `JSON.parse` cannot stand in for the decoder of Python's json module: it refuses
// NaN and the infinities, and it cannot read one value out of a text that goes on.
// `rawDecode` is that decoder, rule for rule, in its strict mode.

import { PY_WS, pyStrip } from "./text";
import { isRecord } from "./values";

// Python's decoder gives up where its recursion limit does. With 3.11 that is 1000
// frames, of which those of the caller are used already; with 3.13 the limit is on
// calls in C: 3000 on Windows, 10000 elsewhere (2998 measured here). A reply nested
// so deep is no card and no memory, so the twin gives up at 1000, where no JavaScript
// stack is short. A Python build with a lower limit, or a caller deep in frames,
// gives up sooner than the twin does.
const MAX_DEPTH = 1000;

// Python 3.11 and later refuse to make an integer of more than this many digits
// (sys.get_int_max_str_digits()): the decoder takes a longer one for an error.
const MAX_INT_DIGITS = 4300;

// Thrown to stop reading at the first thing the decoder refuses, and caught in
// `rawDecode`; never an error of its own, so one instance does.
const UNREADABLE = new Error("unreadable JSON");

function fail(): never {
  throw UNREADABLE;
}

type Read = [value: unknown, end: number];

const isDigit = (code: number) => code >= 0x30 && code <= 0x39;

// The whitespace of JSON, and nothing else: not the no-break space, not the form feed.
function skipSpace(text: string, at: number): number {
  while (at < text.length) {
    const code = text.charCodeAt(at);
    if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) break;
    at++;
  }
  return at;
}

// Four hexadecimal digits, and only those: not what Number() or parseInt() allow.
function hex4(text: string, at: number): number {
  let code = 0;
  for (let i = at; i < at + 4; i++) {
    const c = text.charCodeAt(i);
    let digit = -1;
    if (isDigit(c)) digit = c - 0x30;
    else if (c >= 0x61 && c <= 0x66) digit = c - 0x61 + 10;
    else if (c >= 0x41 && c <= 0x46) digit = c - 0x41 + 10;
    if (digit < 0) fail();
    code = code * 16 + digit;
  }
  return code;
}

function escaped(char: string): string {
  switch (char) {
    case '"':
    case "\\":
    case "/":
      return char;
    case "b":
      return "\b";
    case "f":
      return "\f";
    case "n":
      return "\n";
    case "r":
      return "\r";
    case "t":
      return "\t";
    default:
      return fail();
  }
}

// `from` is just after the opening quote.
function readString(text: string, from: number): [string, number] {
  let out = "";
  let at = from;
  for (;;) {
    let end = at;
    while (end < text.length) {
      const code = text.charCodeAt(end);
      if (code === 0x22 || code === 0x5c) break;
      if (code <= 0x1f) fail(); // a control character, which strict mode refuses
      end++;
    }
    if (end >= text.length) fail(); // no closing quote
    out += text.slice(at, end);
    if (text.charCodeAt(end) === 0x22) return [out, end + 1];

    at = end + 1;
    if (at >= text.length) fail();
    if (text[at] !== "u") {
      out += escaped(text[at]);
      at++;
      continue;
    }
    at++;
    const unit = hex4(text, at);
    at += 4;
    // Python joins a high surrogate and the low one that follows it into one
    // character; side by side, as here, they are that character in UTF-16. Either
    // one alone stays as it is, as in Python.
    out += String.fromCharCode(unit);
  }
}

function readNumber(text: string, from: number): Read {
  let at = from;
  const negative = text[at] === "-";
  if (negative) at++;
  const first = text.charCodeAt(at);
  if (first >= 0x31 && first <= 0x39) {
    at++;
    while (at < text.length && isDigit(text.charCodeAt(at))) at++;
  } else if (first === 0x30) {
    at++; // a number does not go on with more digits after a zero
  } else {
    fail();
  }
  const intEnd = at;

  let fraction = false;
  if (text[at] === "." && isDigit(text.charCodeAt(at + 1))) {
    fraction = true;
    at += 2;
    while (at < text.length && isDigit(text.charCodeAt(at))) at++;
  }
  if (text[at] === "e" || text[at] === "E") {
    const mark = at;
    at++;
    if (text[at] === "-" || text[at] === "+") at++;
    while (at < text.length && isDigit(text.charCodeAt(at))) at++;
    if (isDigit(text.charCodeAt(at - 1))) fraction = true;
    else at = mark; // an "e" with no digits after it is not part of the number
  }

  const digits = text.slice(from, at);
  if (fraction) return [Number(digits), at];
  if (intEnd - from - (negative ? 1 : 0) > MAX_INT_DIGITS) fail();
  // Python's integers have no -0.
  return [Number(digits) || 0, at];
}

function readArray(text: string, from: number, depth: number): Read {
  if (depth >= MAX_DEPTH) fail();
  const items: unknown[] = [];
  let at = skipSpace(text, from);
  if (text[at] !== "]") {
    for (;;) {
      const [value, end] = readValue(text, at, depth + 1);
      items.push(value);
      at = skipSpace(text, end);
      if (text[at] === "]") break;
      if (text[at] !== ",") fail();
      at = skipSpace(text, at + 1);
    }
  }
  return [items, at + 1];
}

function readObject(text: string, from: number, depth: number): Read {
  if (depth >= MAX_DEPTH) fail();
  const entries: [string, unknown][] = [];
  let at = skipSpace(text, from);
  if (text[at] !== "}") {
    for (;;) {
      if (text[at] !== '"') fail();
      const [key, afterKey] = readString(text, at + 1);
      at = skipSpace(text, afterKey);
      if (text[at] !== ":") fail();
      const [value, end] = readValue(text, skipSpace(text, at + 1), depth + 1);
      entries.push([key, value]);
      at = skipSpace(text, end);
      if (text[at] === "}") break;
      if (text[at] !== ",") fail();
      at = skipSpace(text, at + 1);
    }
  }
  // The last of two equal keys wins, as in a dict, and "__proto__" is a key like
  // any other: fromEntries defines the property where an assignment would set the
  // prototype.
  return [Object.fromEntries(entries), at + 1];
}

function readValue(text: string, at: number, depth: number): Read {
  if (at >= text.length) fail();
  switch (text[at]) {
    case '"':
      return readString(text, at + 1);
    case "{":
      return readObject(text, at + 1, depth);
    case "[":
      return readArray(text, at + 1, depth);
    case "n":
      if (text.startsWith("null", at)) return [null, at + 4];
      break;
    case "t":
      if (text.startsWith("true", at)) return [true, at + 4];
      break;
    case "f":
      if (text.startsWith("false", at)) return [false, at + 5];
      break;
    case "N":
      if (text.startsWith("NaN", at)) return [NaN, at + 3];
      break;
    case "I":
      if (text.startsWith("Infinity", at)) return [Infinity, at + 8];
      break;
    case "-":
      if (text.startsWith("-Infinity", at)) return [-Infinity, at + 9];
      break;
  }
  return readNumber(text, at);
}

/** Python's `json.JSONDecoder().raw_decode(text, start)`: the one value that
 *  begins at `start`, whatever follows it, and where it ends. Null where Python
 *  raises. A number is a double: an integer past 2^53 is rounded, and a float whose
 *  value is whole (`1.0`, `1e3`, `5E0`, `-0.0`) is told from an integer in Python and
 *  cannot be here. */
export function rawDecode(text: string, start = 0): { value: unknown; end: number } | null {
  try {
    const [value, end] = readValue(text, start, 0);
    return { value, end };
  } catch (error) {
    if (error === UNREADABLE) return null;
    throw error;
  }
}

// `json.loads`: the whole text is one value. It has no whitespace around it, since
// the one place that calls it has stripped it, and what JSON takes for whitespace
// is less than what Python strips.
function loads(text: string): { value: unknown } | null {
  const found = rawDecode(text);
  return found && found.end === text.length ? found : null;
}

function tryDecode(raw: string): Record<string, unknown> | null {
  const text = pyStrip(raw);
  if (!text) return null;
  // A value that reads and is not an object ends the search, as in Python: a list
  // of objects is not one of them.
  const whole = loads(text);
  if (whole) return isRecord(whole.value) ? whole.value : null;
  const start = text.indexOf("{");
  if (start === -1) return null;
  // One complete object, and no more: what the model says after it is ignored.
  const found = rawDecode(text, start);
  return found && isRecord(found.value) ? found.value : null;
}

// The words of the fence are written out in classes: Python's re.IGNORECASE makes
// U+017F (long s) an "s", which the `i` flag of JavaScript does not.
const TICKS = "```";
const FENCE_RE = new RegExp(`${TICKS}(?:[jJ][sS\u017f][oO][nN])?[${PY_WS}]*([\\s\\S]*?)${TICKS}`);
const TRAILING_COMMA_RE = new RegExp(`,[${PY_WS}]*([}\\]])`, "g");

/** Escape literal control characters inside strings, drop trailing commas. */
function repair(text: string): string {
  const out: string[] = [];
  let inString = false;
  let afterBackslash = false;
  // By code point, as Python walks it; every character that matters is ASCII.
  for (const ch of text) {
    if (inString) {
      if (afterBackslash) {
        afterBackslash = false;
        out.push(ch);
      } else if (ch === "\\") {
        afterBackslash = true;
        out.push(ch);
      } else if (ch === '"') {
        inString = false;
        out.push(ch);
      } else if (ch === "\n") {
        out.push("\\n");
      } else if (ch === "\r") {
        out.push("\\r");
      } else if (ch === "\t") {
        out.push("\\t");
      } else {
        out.push(ch);
      }
    } else {
      if (ch === '"') inString = true;
      out.push(ch);
    }
  }
  return out.join("").replace(TRAILING_COMMA_RE, (_all, bracket: string) => bracket);
}

/** Best-effort extraction of one JSON object from what a model answered: the
 *  text itself, what is inside its first code fence, and what follows its first
 *  "{", each as it is and then repaired. Null if hopeless. */
export function parseLlmJson(text: string): Record<string, unknown> | null {
  if (!text) return null;
  const candidates = [text];
  const fence = FENCE_RE.exec(text);
  if (fence) candidates.push(fence[1]);
  const start = text.indexOf("{");
  if (start > 0) candidates.push(text.slice(start));
  for (const candidate of candidates) {
    const found = tryDecode(candidate) ?? tryDecode(repair(candidate));
    if (found) return found;
  }
  return null;
}
