// Tolerant reading of what a model answers, step for step backend/app/services/llm_json.py:
// the same candidates, tried in the same order, each as it is and then repaired.
//
// Each candidate is decoded by JSON.parse, once a walk over it has made readable what
// Python's decoder reads and JSON.parse refuses: NaN and the infinities outside a string,
// which a browser reads as null (and so do the recorded cases). What Python cannot read,
// JSON.parse cannot either: a control character inside a string, a bad escape, a number
// written as JavaScript would allow it.

import { PY_WS, pyStrip, stripThought } from "./text";

/** A JSON object: neither null nor an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Python's `value.get(key)` on what a model answered: the value's own field, never
 *  one it inherits, such as `constructor`; nothing when the value is no object. */
export function field(value: unknown, key: string): unknown {
  return isRecord(value) && Object.hasOwn(value, key) ? value[key] : undefined;
}

// Python gives up on a reply nested past its recursion limit, which is a few thousand
// deep and depends on the build. A reply nested this deep is no card and no memory: it
// is refused here, by a count rather than by recursion, so no stack can run out.
const MAX_DEPTH = 900;

/** Just past the string that opens at `i`; null if the text stops inside it. */
function stringEnd(text: string, i: number): number | null {
  let escaped = false;
  for (let j = i + 1; j < text.length; j++) {
    const ch = text[j];
    if (escaped) escaped = false;
    else if (ch === "\\") escaped = true;
    else if (ch === '"') return j + 1;
  }
  return null;
}

const LITERALS: [written: string, read: string][] = [
  ["NaN", "null"],
  ["Infinity", "null"],
  ["-Infinity", "null"],
];
// Where a value may begin: an integer -0 there is Python's 0, never JavaScript's -0.
const BEFORE_A_VALUE = new Set(["[", ",", ":", " ", "\t", "\n", "\r"]);
const AFTER_A_NUMBER_GOES_ON = /[0-9.eE]/;

/** The text from `start` as JSON.parse can read it. With `one`, only the object that
 *  opens at `start`, whatever follows it, and null if it never closes; otherwise the
 *  text to its end. Null too when brackets nest deeper than MAX_DEPTH. */
function readable(text: string, start: number, one: boolean): string | null {
  let out = "";
  let from = start; // where the text not yet copied to `out` begins
  let depth = 0;
  let i = start;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      // A string is copied as it is; one that never closes leaves JSON.parse to refuse.
      i = stringEnd(text, i) ?? text.length;
      continue;
    }
    if (ch === "{" || ch === "[") {
      if (++depth > MAX_DEPTH) return null;
    } else if (ch === "}" || ch === "]") {
      depth--;
      if (one && depth === 0) return out + text.slice(from, i + 1);
    } else {
      const literal = LITERALS.find(([written]) => text.startsWith(written, i));
      if (literal) {
        out += text.slice(from, i) + literal[1];
        i += literal[0].length;
        from = i;
        continue;
      }
      if (
        ch === "-" &&
        text[i + 1] === "0" &&
        (i === start || BEFORE_A_VALUE.has(text[i - 1])) &&
        !AFTER_A_NUMBER_GOES_ON.test(text[i + 2] ?? "")
      ) {
        out += text.slice(from, i) + "0";
        i += 2;
        from = i;
        continue;
      }
    }
    i++;
  }
  return one ? null : out + text.slice(from);
}

// A double does not say every number as Python reads it: a float that is whole (`1.0`,
// `1e2`, `-0.0`) is no int there, and an integer keeps every digit, past 2^53 as past
// 10^308. Where the browser hands a reviver the number's source text, the source of such
// a number is kept beside the list or object that holds it, for `words`; elsewhere, and in
// a browser that does not, a number is what the double says.
const numberSources = new WeakMap<object, Map<string, string>>();

/** The source text of the number at `key` of `holder`, read from a model's answer, when
 *  a double says it otherwise than Python: a whole float, or an integer a double rounds
 *  or cannot hold. Undefined for any other value. */
export function numberSource(holder: object, key: string): string | undefined {
  return numberSources.get(holder)?.get(key);
}

function noteSource(holder: object, key: string, source: string): void {
  const sources = numberSources.get(holder) ?? new Map<string, string>();
  sources.set(key, source);
  numberSources.set(holder, sources);
}

/** Whether a double says the number written `source` otherwise than Python reads it. */
const misread = (value: number, source: string) =>
  /[.eE]/.test(source) ? Number.isInteger(value) : !Number.isSafeInteger(value);

type Decoded = { value: unknown; source?: string };

function parsed(json: string | null): Decoded | null {
  if (json === null) return null;
  // The reviver is called for the whole value last, under the key "".
  let rootSource: string | undefined;
  function revive(this: unknown, key: string, value: unknown, context?: { source?: string }): unknown {
    if (typeof value !== "number") {
      if (key === "") rootSource = undefined;
      return value;
    }
    const written = context?.source;
    const source = written !== undefined && misread(value, written) ? written : undefined;
    if (key === "") rootSource = source;
    if (source !== undefined && typeof this === "object" && this !== null) noteSource(this, key, source);
    // An infinity that a number too large becomes is read as null, as Python's
    // infinite floats are in the recorded cases: an integer of more than 308 digits
    // too, which Python keeps, but whose source is noted above.
    return Number.isFinite(value) ? value : null;
  }
  try {
    const value: unknown = JSON.parse(json, revive);
    return rootSource === undefined ? { value } : { value, source: rootSource };
  } catch {
    return null;
  }
}

/** Python's `json.loads`: the whole text is one value, with JSON whitespace around it. */
function loads(text: string): Decoded | null {
  return parsed(readable(text, 0, false));
}

function tryDecode(raw: string): Record<string, unknown> | null {
  const text = pyStrip(raw);
  if (!text) return null;
  // A value that reads and is no object ends the search, as in Python: a list of
  // objects is not one of them.
  const whole = loads(text);
  if (whole) return isRecord(whole.value) ? whole.value : null;
  const start = text.indexOf("{");
  if (start === -1) return null;
  // Python's raw_decode: one complete object, and what the model says after it ignored.
  const found = parsed(readable(text, start, true));
  return found && isRecord(found.value) ? found.value : null;
}

// Python's `\s*` with re.IGNORECASE: its whitespace, and "json" in any case, the long s
// (U+017F) included, which only the `u` flag folds to an "s" here.
const FENCE_RE = new RegExp(`\`\`\`(?:json)?[${PY_WS}]*([\\s\\S]*?)\`\`\``, "iu");
const SPACE = new RegExp(`[${PY_WS}]`);

// Python's `_CLOSER_RE.match(text, at)`: spaces, then a closing bracket.
function closerAt(text: string, at: number): boolean {
  while (at < text.length && SPACE.test(text[at])) at++;
  return text[at] === "}" || text[at] === "]";
}

/** Escape literal control characters inside strings, drop trailing commas outside them. */
function repair(text: string): string {
  const out: string[] = [];
  let inString = false;
  let escaped = false;
  // Unit by unit where Python goes by code point: every character that matters is ASCII.
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        out.push(ch);
      } else if (ch === "\\") {
        escaped = true;
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
    } else if (ch !== "," || !closerAt(text, i + 1)) {
      inString = ch === '"';
      out.push(ch);
    }
  }
  return out.join("");
}

/** Best-effort extraction of one JSON object from what a model answered: the text
 *  itself, what is inside its first code fence, and what follows its first "{", each
 *  as it is and then repaired. Null if nothing can be read. */
export function parseLlmJson(text: string): unknown {
  const answer = stripThought(text);
  if (!answer) return null;
  const candidates = [answer];
  const fence = FENCE_RE.exec(answer);
  if (fence) candidates.push(fence[1]);
  const start = answer.indexOf("{");
  if (start > 0) candidates.push(answer.slice(start));
  for (const candidate of candidates) {
    for (const attempt of [candidate, repair(candidate)]) {
      const found = tryDecode(attempt);
      if (found) return found;
    }
  }
  return null;
}

// What partialJson reads by, as llm_json.py does: JSON's own whitespace.
const JSON_SPACE = " \t\r\n";
const LITERAL_END = ",}]" + JSON_SPACE;

function skipSpace(text: string, i: number): number {
  while (i < text.length && JSON_SPACE.includes(text[i])) i++;
  return i;
}

/** Just past the value that starts at `i`; null if the text stops before it is whole.
 *  A number or a literal is whole only once something follows it: "12" may yet be "123". */
function valueEnd(text: string, i: number): number | null {
  if (text[i] === '"') return stringEnd(text, i);
  if (text[i] === "{" || text[i] === "[") {
    let depth = 0;
    let j = i;
    while (j < text.length) {
      const ch = text[j];
      if (ch === '"') {
        const end = stringEnd(text, j);
        if (end === null) return null;
        j = end;
        continue;
      }
      if (ch === "{" || ch === "[") depth++;
      else if (ch === "}" || ch === "]") {
        depth--;
        if (depth === 0) return j + 1;
      }
      j++;
    }
    return null;
  }
  let j = i;
  while (j < text.length && !LITERAL_END.includes(text[j])) j++;
  return j < text.length ? j : null;
}

function decode(token: string): Decoded | null {
  return loads(repair(token));
}

/** The whole elements of the list that opens at `i` and that the text stops inside. */
function listSoFar(text: string, i: number): unknown[] {
  const items: unknown[] = [];
  i++;
  for (;;) {
    i = skipSpace(text, i);
    while (i < text.length && text[i] === ",") i = skipSpace(text, i + 1);
    if (i >= text.length || text[i] === "]") return items;
    const end = valueEnd(text, i);
    if (end === null) return items;
    const item = decode(text.slice(i, end));
    if (!item) return items;
    // Read alone, a number's source is the list's to keep, as when the list is read whole.
    if (item.source !== undefined) noteSource(items, String(items.length), item.source);
    items.push(item.value);
    i = end;
  }
}

function readPartial(text: string): [Record<string, unknown>, string | null] {
  // A Map, since a field may be named "__proto__"; and the last of two equal names
  // wins in the place of the first, as in a dict.
  const fields = new Map<string, unknown>();
  const done = (writing: string | null): [Record<string, unknown>, string | null] => [
    Object.fromEntries(fields),
    writing,
  ];
  let i = text.indexOf("{");
  if (i === -1) return done(null);
  i++;
  for (;;) {
    i = skipSpace(text, i);
    while (i < text.length && text[i] === ",") i = skipSpace(text, i + 1);
    if (i >= text.length || text[i] !== '"') return done(null); // between two fields, at the end, or lost
    const keyEnd = stringEnd(text, i);
    if (keyEnd === null) return done(null); // the name itself is not whole yet
    const name = decode(text.slice(i, keyEnd));
    if (!name || typeof name.value !== "string") return done(null);
    const key = name.value;
    i = skipSpace(text, keyEnd);
    if (i >= text.length) return done(key);
    if (text[i] !== ":") return done(null);
    i = skipSpace(text, i + 1);
    if (i >= text.length) return done(key);
    const end = valueEnd(text, i);
    if (end === null) {
      if (text[i] === "[") fields.set(key, listSoFar(text, i));
      return done(key);
    }
    const value = decode(text.slice(i, end));
    if (!value) return done(null);
    fields.set(key, value.value);
    i = end;
  }
}

/** The top-level fields of an answer's object that are complete, and the name of the
 *  one being written where the text stops: an answer read while it arrives, or one cut
 *  short. A list still being written gives the elements it has finished, under its name,
 *  which is then the one being written. What parseLlmJson reads whole, this reads the same. */
export function partialJson(text: string): [Record<string, unknown>, string | null] {
  const whole = parseLlmJson(text);
  if (isRecord(whole)) return [whole, null];
  return readPartial(stripThought(text));
}
