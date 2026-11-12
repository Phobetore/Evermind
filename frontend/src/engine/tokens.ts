import { codePoints } from "./text";

/** Rough token count without a tokenizer: about 3.5 characters a token, counted in
 *  code points as Python counts them, so that a text full of emoji costs the same. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.trunc(codePoints(text) / 3.5) + 1;
}
