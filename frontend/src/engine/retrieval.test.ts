import { expect, test } from "vitest";
import { cosineScores } from "./retrieval";

// numpy refuses these (a matrix that is not a matrix, or a product of shapes
// that do not fit), and the cases of parity/ cannot hold a call that raises.
test("rows that are not all as long as each other are refused", () => {
  expect(() => cosineScores([1, 0], [[1, 0], [1]])).toThrow();
  expect(() => cosineScores([], [[], [1]])).toThrow();
});

test("a query that is not as long as the rows is refused", () => {
  expect(() => cosineScores([1], [[1, 0]])).toThrow();
  expect(() => cosineScores([1, 0, 0], [[1, 0]])).toThrow();
});

// numpy answers an empty matrix before it looks at the query.
test("a matrix with nothing in it has no scores, whatever the query is", () => {
  expect(cosineScores([1, 0], [])).toEqual([]);
  expect(cosineScores([1, 0], [[], []])).toEqual([]);
});
