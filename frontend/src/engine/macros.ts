// Card macro substitution: {{char}}, {{user}}, {{original}}, whatever their case.

import { PY_WS } from "./text";

// The words are spelled out in classes rather than matched with the `i` flag: Python's
// re.IGNORECASE makes U+017F (long s) an "s" and U+0130 and U+0131 (dotted capital I,
// dotless i) an "i", and no flag of JavaScript's does all of that.
const macro = (word: string) => new RegExp(`\\{\\{[${PY_WS}]*${word}[${PY_WS}]*\\}\\}`, "g");

const CHAR_RE = macro("[cC][hH][aA][rR]");
const USER_RE = macro("[uU][sSſ][eE][rR]");
const ORIGINAL_RE = macro("[oO][rR][iIİı][gG][iIİı][nN][aA][lL]");

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
