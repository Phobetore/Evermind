import { codePoints } from "./text";

/** Rough token estimate without a tokenizer: about 3.5 characters a token,
 *  counted in code points like the Python it mirrors. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.trunc(codePoints(text) / 3.5) + 1;
}
