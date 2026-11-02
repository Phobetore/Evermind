import { expect, test } from "vitest";
import { planMemoryChanges } from "./memoryChanges";

// What the cases of parity/memory_changes.json cannot say, since they only see what
// a function returns: that it leaves the facts alone. backend/tests/test_memory_changes.py
// says the same of the Python.

const existing = () => [
  { id: "1", content: "Pinned fact.", is_pinned: true, source: "auto" },
  { id: "2", content: "Old one.", is_pinned: false, source: "auto" },
  { id: "3", content: "Hand fact.", is_pinned: false, source: "user" },
];
const answer = () => ({
  facts: [{ content: "Fresh.", kind: "event" }],
  updated_facts: [
    { replaces: "Old one.", content: "Old one, corrected." },
    { replaces: "Fresh.", content: "Fresh, corrected." },
  ],
  obsolete_facts: ["Old one, corrected.", "Hand fact."],
  summary: " Summed up. ",
});

test("planning leaves the facts as they were", () => {
  const facts = existing();

  const plan = planMemoryChanges(answer(), facts, 9);

  expect(facts).toEqual(existing());
  // What it did decide, so that the test is about an answer that changes things.
  expect(plan.ops.map((op) => op.op)).toEqual(["add", "update", "update", "delete"]);
});
