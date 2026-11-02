// Choosing past messages to quote, a copy of what is pure in
// backend/app/prompting/retrieval.py: the cases of parity/retrieval.json fail when
// it differs. Ranking itself (embedding the scene and the messages) needs a model,
// and is not here.

import { sortedBy } from "./chat";
import { estimateTokens } from "./tokens";

export interface RankedCandidate {
  id: string;
  content?: string | null;
  position?: number | null;
}

/** The most relevant past messages that fit `tokenBudget`, skipping any whose
 *  turn is already covered (`excludePositions`). Highest score first for the
 *  choosing; returned oldest-first for reading. A candidate with no score is
 *  not a candidate. */
export function selectPassages<C extends RankedCandidate>(
  ranked: Readonly<Record<string, number>>,
  candidates: readonly C[],
  tokenBudget: number,
  excludePositions: ReadonlySet<number | null> | null = null,
): C[] {
  const exclude = excludePositions ?? new Set<number | null>();
  // Own properties only: an id such as "constructor" is not a score.
  const scored = candidates.filter(
    (c) => Object.hasOwn(ranked, c.id) && !exclude.has(c.position ?? null),
  );
  const kept: C[] = [];
  let budget = tokenBudget;
  for (const c of sortedBy(scored, (c) => ranked[c.id], true)) {
    const cost = estimateTokens(c.content || "");
    if (cost > budget) continue;
    budget -= cost;
    kept.push(c);
  }
  return sortedBy(kept, (c) => c.position ?? 0);
}

/** Cosine similarity of a query vector against each row. The vectors are
 *  normalised where they are made, so it is a dot product. Python adds up in
 *  float32 and this in double: the two agree when the numbers are exact in
 *  float32 (the only ones the cases use), and differ by rounding when they are
 *  not, around 1e-7 and more on a long vector. Two different texts whose scores
 *  lie that close may therefore rank in another order here than on the server.
 *  Identical vectors score the same in both and tie in both. That is accepted.
 *
 *  Throws on rows of different lengths and on a query that is not as long as
 *  they are, as numpy does: the Python ranking catches that and falls back on
 *  recency, and so must whatever calls this. */
export function cosineScores(
  queryVec: readonly number[],
  rows: readonly (readonly number[])[],
): number[] {
  const width = rows.length ? rows[0].length : 0;
  if (rows.some((row) => row.length !== width)) {
    throw new Error("the rows are not all as long as each other");
  }
  if (width === 0) return [];
  if (queryVec.length !== width) {
    throw new Error(`the query has ${queryVec.length} numbers and the rows ${width}`);
  }
  return rows.map((row) => {
    let sum = 0;
    for (let i = 0; i < width; i++) sum += row[i] * queryVec[i];
    return sum;
  });
}
