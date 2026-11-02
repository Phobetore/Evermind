import { expect, test } from "vitest";
import { planConsolidation, planMemoryChanges } from "./memoryChanges";

// What the cases of parity/memory_changes.json cannot say, since they only see what
// a function returns: what it leaves alone. backend/tests/test_memory_changes.py
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

test("planning leaves the facts and the answer as they were", () => {
  const facts = existing();
  const reply = answer();

  const plan = planMemoryChanges(reply, facts, 9);

  expect(facts).toEqual(existing());
  expect(reply).toEqual(answer());
  // What it did decide, so that the test is about an answer that changes things.
  expect(plan.ops.map((op) => op.op)).toEqual(["add", "update", "update", "delete"]);
});

test("planning a consolidation leaves the answer and the facts as they were", () => {
  const reply = { facts: [{ content: " One. " }, { content: "Two.", kind: "event" }] };
  const movable = [{ source_position: 5 }, { source_position: 2 }];

  const plan = planConsolidation(reply, movable);

  expect(reply).toEqual({ facts: [{ content: " One. " }, { content: "Two.", kind: "event" }] });
  expect(movable).toEqual([{ source_position: 5 }, { source_position: 2 }]);
  expect(plan).toEqual({
    facts: [
      { content: "One.", kind: "fact" },
      { content: "Two.", kind: "event" },
    ],
    source_position: 2,
  });
});
