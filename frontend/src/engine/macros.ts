// Card macro substitution: {{char}}, {{user}}, {{original}}, whatever their case, and, for the
// rules of community cards, the rest of a card's markers (expandMacros).

import { PY_DIGIT, PY_WS, pyInt, pyStrip } from "./text";

// The words are spelled out in classes rather than matched with the `i` flag: Python's
// re.IGNORECASE makes U+017F (long s) an "s", U+0130 and U+0131 (dotted capital I,
// dotless i) an "i" and U+212A (Kelvin sign) a "k", and no flag of JavaScript's does all of that.
const macro = (word: string) => new RegExp(`\\{\\{[${PY_WS}]*${word}[${PY_WS}]*\\}\\}`, "g");

const CHAR_RE = macro("[cC][hH][aA][rR]");
const USER_RE = macro("[uU][sSſ][eE][rR]");
const ORIGINAL_RE = macro("[oO][rR][iIİı][gG][iIİı][nN][aA][lL]");

// A marker's body never holds a brace ([^{}]*, not a lazy match of anything): an unclosed one
// then ends at the next brace, where it would otherwise scan to the end of the text for each
// possible start. A roll's separator, "::", ":" or a space, is written so that a run of spaces
// can be read one way only, as in macros.py. The `u` flag makes `{1,9}` count characters, as
// Python does, and not the two halves of a digit outside the basic plane.
const SPACE = `[${PY_WS}]`;
const COMMENT_RE = new RegExp(`\\{\\{${SPACE}*\\/\\/[^{}]*\\}\\}`, "gu");
const MARKER_RE = new RegExp(
  `\\{\\{${SPACE}*(?:([rR][aA][nN][dD][oO][mM]|[pP][iIİı][cC][kK\\u212a])${SPACE}*(::|:)([^{}]*)` +
    `|[rR][oO][lL][lL](?:${SPACE}*::?${SPACE}*|${SPACE}+)(?:1?[dD])?([${PY_DIGIT}]{1,9})${SPACE}*)\\}\\}`,
  "gu",
);
const UNESCAPED_COMMA_RE = /(?<!\\),/;
// The first format's names, in one pass so that a name holding one of them is left as it is.
const NAME_TAG_RE = /<(?:([uU][sSſ][eE][rR])|[bB][oO][tT]|[cC][hH][aA][rR])>/g;

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
// Half of a surrogate is written as the replacement character, as Python's side does by hand.
const encoder = new TextEncoder();

function fnv1aBytes(bytes: Uint8Array, start: number = FNV_OFFSET): number {
  let h = start;
  for (const byte of bytes) h = Math.imul(h ^ byte, FNV_PRIME) >>> 0;
  return h;
}

// A function gives the replacement, never a string: a string is read for "$&", "$1"
// and the like, and a name may contain them.
export function substitute(text: string, charName: string, userName: string): string {
  if (!text) return "";
  return text.replace(CHAR_RE, () => charName).replace(USER_RE, () => userName);
}

export function substituteOriginal(text: string, original: string): string {
  if (!text) return "";
  return text.replace(ORIGINAL_RE, () => original);
}

export function hasOriginalMacro(text: string): boolean {
  // `search`, since `test` on a global RegExp goes on from where it last stopped.
  return !!text && text.search(ORIGINAL_RE) !== -1;
}

/** A card's markers in one text, for the card rules: comments out, choices made, names in.
 *  The chance is FNV-1a on 32 bits of the seed, the text as given and each marker's rank, so
 *  that the same text draws the same in both engines and in every turn of one story. */
export function expandMacros(text: string, charName: string, userName: string, seed: string): string {
  if (!text) return "";
  // The hash of what comes before each marker's rank is the same for every marker: found once,
  // and only when there is one, so that a long text is not hashed again for each.
  let prefix: number | null = null;
  let rank = -1;

  const choose = (
    marker: string,
    kind: string | undefined,
    separator: string | undefined,
    body: string | undefined,
    sides: string | undefined,
  ): string => {
    rank += 1;
    prefix ??= fnv1aBytes(encoder.encode(`${seed}\0${text}\0`));
    const h = fnv1aBytes(encoder.encode(String(rank)), prefix);
    if (kind !== undefined) {
      const inside = body as string;
      const parts = separator === "::" ? inside.split("::") : inside.split(UNESCAPED_COMMA_RE);
      const choices = parts.map((part) => pyStrip(part.replaceAll("\\,", ",")));
      return choices.length ? choices[h % choices.length] : "";
    }
    const count = pyInt(sides as string);
    return count ? String(1 + (h % count)) : marker;
  };

  const expanded = text
    .replace(COMMENT_RE, "")
    .replace(MARKER_RE, choose)
    .replace(NAME_TAG_RE, (_tag, user: string | undefined) => (user !== undefined ? userName : charName));
  return substitute(expanded, charName, userName);
}
