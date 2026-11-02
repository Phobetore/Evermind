import { PY_WS } from "./text";

// The word is spelled out in classes rather than matched with the `i` flag:
// Python's re.IGNORECASE makes "ſ" an "s" and "İ" and "ı" an "i", and no flag
// of JavaScript's does the same.
const macro = (word: string) => new RegExp(`\\{\\{[${PY_WS}]*${word}[${PY_WS}]*\\}\\}`, "g");

const CHAR_RE = macro("[cC][hH][aA][rR]");
const USER_RE = macro("[uU][sSſ][eE][rR]");
const ORIGINAL_RE = macro("[oO][rR][iIİı][gG][iIİı][nN][aA][lL]");

// A function gives the replacement, never a string: a string is read for "$&",
// "$1" and the like, and a name may contain them.
export function substitute(text: string, charName: string, userName: string): string {
  if (!text) return "";
  return text.replace(CHAR_RE, () => charName).replace(USER_RE, () => userName);
}

export function substituteOriginal(text: string, original: string): string {
  if (!text) return "";
  return text.replace(ORIGINAL_RE, () => original);
}

export function hasOriginalMacro(text: string): boolean {
  // `search`, since `test` on a global regex goes on from where it stopped.
  return !!text && text.search(ORIGINAL_RE) !== -1;
}
