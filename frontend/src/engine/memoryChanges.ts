// What a model's answer changes in the memory of a conversation, step for step
// backend/app/prompting/memory_changes.py: the facts to add, to correct and to drop,
// and the summary to keep, decided from the answer alone. No storage, no model.
//
// Only a string is text (`textOf`): a `content` or a `replaces` that is a number, a
// list or null is absent, and so is one that cannot be written (a lone surrogate). Only
// an array is a list: a string would be read letter by letter.

import { field } from "./llmJson";
import { textOf } from "./text";

export const MAX_TURNS_PER_RUN = 40; // safety cap on turns fed to one extraction call

const items = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** A fact as the conversation remembers it, in the order the repository looks one up:
 *  the pinned ones, then the oldest. */
export interface KnownFact {
  id: string;
  content: string;
  is_pinned: boolean;
  source: string;
}

export type MemoryPlan = {
  add: { content: string; source_position: number }[];
  update: Record<string, string>;
  delete: string[];
  summary: string | null;
};

/** Whether the model may correct, drop or merge a fact: it wrote it and nobody pinned it. */
export const isMovable = (fact: { is_pinned: boolean; source: string }): boolean =>
  !fact.is_pinned && fact.source === "auto";

/** The facts that consolidation may merge: neither pinned nor written by hand. */
export const movableFacts = <F extends { is_pinned: boolean; source: string }>(memories: F[]): F[] =>
  memories.filter(isMovable);

/** Every text that the changes of an extraction's answer can write. */
export function answerTexts(parsed: Record<string, unknown>): string[] {
  const found = [...items(field(parsed, "facts")), ...items(field(parsed, "updated_facts"))];
  return found.map((item) => textOf(field(item, "content"))).filter((text) => text !== "");
}

type Known = {
  id?: string;
  added?: { content: string; source_position: number };
  content: string;
  movable: boolean;
};

/** The changes an extraction's answer makes to `existing`, the facts as they are, each
 *  with its id. Each change is decided on what the ones before it leave, so the answer
 *  can correct or drop a fact it adds; a text reaches the first fact of `existing` that
 *  says it. The model corrects or drops only a fact it wrote and nobody pinned, adds
 *  nothing in place of the others, and drops a fact it corrects into another fact's text.
 *  Applied deletes, then updates, then adds, so an add never repeats what a fact says. */
export function planMemoryChanges(
  parsed: Record<string, unknown>,
  existing: KnownFact[],
  topPosition: number,
): MemoryPlan {
  let known: Known[] = existing.map((m) => ({ id: m.id, content: m.content, movable: isMovable(m) }));
  let adds: MemoryPlan["add"] = [];
  // A Map until the end, since an id is a key like any other, "__proto__" included.
  const updates = new Map<string, string>();
  const deletes: string[] = [];

  const add = (content: string) => {
    if (!content || known.some((m) => m.content === content)) return;
    const added = { content, source_position: topPosition };
    adds.push(added);
    known.push({ added, content, movable: true });
  };

  const find = (text: unknown) => {
    const wanted = textOf(text);
    return known.find((m) => m.content === wanted);
  };

  const correct = (fact: Known, content: string) => {
    fact.content = content;
    if (fact.added) fact.added.content = content;
    else updates.set(fact.id as string, content);
  };

  const drop = (fact: Known) => {
    known = known.filter((m) => m !== fact);
    if (fact.added) {
      adds = adds.filter((a) => a !== fact.added);
    } else {
      updates.delete(fact.id as string);
      deletes.push(fact.id as string);
    }
  };

  for (const fact of items(field(parsed, "facts"))) add(textOf(field(fact, "content")));

  for (const update of items(field(parsed, "updated_facts"))) {
    const newContent = textOf(field(update, "content"));
    if (!newContent) continue;
    const target = find(field(update, "replaces"));
    if (target === undefined) {
      add(newContent);
    } else if (target.movable) {
      if (known.some((m) => m !== target && m.content === newContent)) drop(target);
      else correct(target, newContent);
    }
  }

  for (const obsolete of items(field(parsed, "obsolete_facts"))) {
    const target = find(obsolete);
    if (target && target.movable) drop(target);
  }

  return {
    add: adds,
    update: Object.fromEntries(updates),
    delete: deletes,
    summary: textOf(field(parsed, "summary")) || null,
  };
}

/** The facts that replace `movable` once the model has merged them, or null when its
 *  answer holds none that can be read. They take the oldest position of those they
 *  replace: a recent one would read as covered by the visible history, and keep them
 *  from the model for dozens of turns. Two may say the same thing: adding them drops
 *  the second. */
export function planConsolidation(
  parsed: Record<string, unknown> | null,
  movable: { source_position: number }[],
): { facts: string[]; source_position: number } | null {
  const facts = items(field(parsed, "facts"))
    .map((item) => textOf(field(item, "content")))
    .filter((text) => text !== "");
  if (!facts.length) return null;
  // Python's `min()`: the first of the smallest, by `<`. Not Math.min, which runs out of
  // arguments on a very long list, and prefers -0 to 0 and NaN to any number.
  let oldest = movable.length ? movable[0].source_position : 0;
  for (const m of movable) if (m.source_position < oldest) oldest = m.source_position;
  return { facts, source_position: oldest };
}
