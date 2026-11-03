import { expect, test } from "vitest";
import { planCut, planMemoryChanges } from "./memoryChanges";

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

test("planning a cut leaves what it reads as it was", () => {
  const read = () => ({
    checkpoints: [
      { position: 8, summary: "S8", memory_position: 8, facts: [
        { id: "a", kind: "fact", content: "As it was.", source_position: 8 },
      ] },
      { position: 16, summary: "S16", memory_position: 16, facts: [] },
    ],
    facts: [
      { id: "a", kind: "fact", content: "Changed.", source_position: 8, is_pinned: 0, source: "auto" },
      { id: "p", kind: "fact", content: "Pinned.", source_position: 16, is_pinned: 1, source: "auto" },
    ],
  });
  const given = read();

  const plan = planCut(16, "S16", given.checkpoints, given.facts, 10, true);

  expect(given).toEqual(read());
  // What it did decide, so that the test is about a cut that changes things.
  expect(plan.facts.map((f) => [f.id, f.content, f.source_position])).toEqual([
    ["p", "Pinned.", 10],
    ["a", "As it was.", 8],
  ]);
});

test("planning leaves the facts as they were", () => {
  const facts = existing();

  const plan = planMemoryChanges(answer(), facts, 9);

  expect(facts).toEqual(existing());
  // What it did decide, so that the test is about an answer that changes things.
  expect(plan.ops.map((op) => op.op)).toEqual(["add", "update", "update", "delete"]);
});
