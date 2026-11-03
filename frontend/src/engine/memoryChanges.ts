// What a model's answer changes in the memory of a conversation, a copy of
// backend/app/prompting/memory_changes.py: the cases of parity/memory_changes.json
// fail when a single change differs.
//
// Only a string is text. A `content`, a `kind` or a `replaces` that is a number,
// a list or null is absent; and what is not an array is no array, where a string
// would be read letter by letter. A string that cannot be written (a lone surrogate)
// is absent too: it would fail in the database, after the changes before it were saved.

import { pyStrip, textOf } from "./text";
import { isRecord } from "./values";

const ALLOWED_KINDS: ReadonlySet<string> = new Set([
  "fact",
  "event",
  "relationship",
  "promise",
  "state",
]);
const MAX_CONSOLIDATED_FACTS = 30; // what one consolidation may leave of the model's merge

const items = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const kindOf = (value: unknown): string =>
  typeof value === "string" && ALLOWED_KINDS.has(value) ? value : "fact";

/** Whether the model may correct, drop or merge a fact: it wrote it and nobody pinned
 *  it. What a person typed or pinned is left alone. */
export const isMovable = (fact: {
  is_pinned?: boolean | number | null;
  source?: string | null;
}): boolean => !fact.is_pinned && fact.source === "auto";

/** What a pass left: the running summary as it stood when the turns up to `position`
 *  had been read, and how far the facts had been read then. */
export interface Checkpoint {
  position: number;
  summary: string;
  memory_position: number;
}

/** What `planCut` reads of a fact. */
export interface CutFact {
  id: string;
  source_position: number;
  is_pinned?: boolean | number | null;
  source?: string | null;
}

export interface CutMemory {
  memory_position: number;
  summary: string;
  /** The positions of the checkpoints that are kept. */
  checkpoints: number[];
  /** The ids of the facts that are kept. */
  facts: string[];
}

/** What a conversation remembers once its story ends with the turn at `cut`: a removal
 *  from position p cuts at p - 1, a branch at the position of its message.
 *
 *  The facts that the model drew from turns after the cut go; a fact's position is the
 *  newest turn of the pass that drew it, so it goes with them even if the turn it came
 *  from stays, and the next pass draws it again. What a person typed or pinned stays,
 *  whatever its position, since only they take it away.
 *
 *  The checkpoints after the cut go. The memory goes back to the newest one at or before
 *  it, with its summary: the facts were read as far as it says, so the next pass reads
 *  from there, at the usual cost, and the summary is true of the story as it now is.
 *  That happens when the memory had read past the cut, or when the summary is the one
 *  written after it (a summary asked for describes the turns up to the last message
 *  without the facts having been read as far). Without a checkpoint at or before the cut
 *  the memory has read nothing it can vouch for: it goes back to the newest turn that a
 *  fact it keeps was drawn from, which a pinned fact does not count for, since it
 *  survives cuts and can carry the position of a story that is gone, or to the start;
 *  and the summary is emptied.
 *
 *  A summary that is not the newest checkpoint's (after stripping) was typed by a
 *  person, in a box that is theirs to edit: it stays, as a fact they wrote does. */
export function planCut(
  memoryPosition: number,
  summary: string,
  checkpoints: readonly Checkpoint[],
  facts: readonly CutFact[],
  cut: number,
): CutMemory {
  const keptFacts = facts.filter((f) => !isMovable(f) || f.source_position <= cut);
  const ordered = [...checkpoints].sort((a, b) => a.position - b.position);
  const kept = ordered.filter((c) => c.position <= cut);
  const chosen = kept.length ? kept[kept.length - 1] : undefined;
  const newest = ordered.length ? ordered[ordered.length - 1] : undefined;
  const typed = pyStrip(summary) !== (newest ? pyStrip(newest.summary) : "");
  const summaryIsAhead = !typed && newest !== undefined && newest.position > cut;
  const result: CutMemory = {
    memory_position: memoryPosition,
    summary,
    checkpoints: kept.map((c) => c.position),
    facts: keptFacts.map((f) => f.id),
  };
  if (memoryPosition <= cut && !summaryIsAhead) return result;

  let reached = 0;
  if (chosen) {
    reached = chosen.memory_position;
  } else {
    for (const f of keptFacts) if (isMovable(f)) reached = Math.max(reached, f.source_position);
  }
  result.memory_position = Math.min(memoryPosition, reached);
  if (!typed) result.summary = chosen ? chosen.summary : "";
  return result;
}

/** What `planMemoryChanges` reads of a fact the conversation remembers. */
export interface KnownFact {
  content: string;
  is_pinned?: boolean | null;
  source?: string | null;
}

export type MemoryOp =
  | { op: "add"; content: string; kind: string; source_position: number; source: "auto" }
  | { op: "update"; target: string; content: string }
  | { op: "delete"; target: string };

export interface MemoryChanges {
  ops: MemoryOp[];
  summary: string | null;
}

/** The changes that an extraction's answer makes, in the order they are applied:
 *  the facts it adds, then those it corrects, then those it drops. Each is decided
 *  on what the ones before it leave, so that one can reach a fact that an earlier
 *  one added. Several facts can say the same thing, since a person may edit one into
 *  what another says: the first of `existing` is the one a later correction or drop
 *  reaches, so it comes in the order in which the repository looks a fact up (the
 *  pinned ones, then the oldest).
 *
 *  Only a fact that the model wrote and nobody pinned is for it to correct or drop:
 *  it leaves alone what a person typed or pinned, and adds nothing in its place. A
 *  correction into the text of another fact drops the corrected one instead, since
 *  what it says is recorded already. */
export function planMemoryChanges(
  parsed: Record<string, unknown>,
  existing: readonly KnownFact[],
  topPosition: number,
): MemoryChanges {
  const known = existing.map((m) => ({
    content: m.content,
    is_pinned: Boolean(m.is_pinned),
    source: m.source,
  }));
  const ops: MemoryOp[] = [];

  // What `memories_repo.add` does with a stripped text: nothing when it is empty
  // or already said, and a fact that the next change may reach otherwise.
  const add = (content: string, kind: string) => {
    if (!content || known.some((m) => m.content === content)) return;
    known.push({ content, is_pinned: false, source: "auto" });
    ops.push({ op: "add", content, kind, source_position: topPosition, source: "auto" });
  };
  // What `memories_repo.find_by_content` finds.
  const find = (text: unknown) => {
    const wanted = textOf(text);
    return known.find((m) => m.content === wanted);
  };
  const drop = (fact: (typeof known)[number]) => {
    ops.push({ op: "delete", target: fact.content });
    known.splice(known.indexOf(fact), 1);
  };

  for (const fact of items(parsed.facts)) {
    if (isRecord(fact)) add(textOf(fact.content), kindOf(fact.kind));
  }

  // Corrections and merges.
  for (const update of items(parsed.updated_facts)) {
    const newContent = isRecord(update) ? textOf(update.content) : "";
    if (!newContent) continue;
    const target = find(isRecord(update) ? update.replaces : undefined);
    if (target === undefined) {
      add(newContent, "fact");
    } else if (isMovable(target)) {
      if (known.some((m) => m !== target && m.content === newContent)) {
        drop(target);
      } else {
        ops.push({ op: "update", target: target.content, content: newContent });
        target.content = newContent;
      }
    }
  }

  for (const obsolete of items(parsed.obsolete_facts)) {
    const target = find(obsolete);
    if (target && isMovable(target)) drop(target);
  }

  return { ops, summary: textOf(parsed.summary) || null };
}

export interface Consolidation {
  facts: { content: string; kind: string }[];
  source_position: number;
}

/** The facts that replace `movable` once the model has merged them, or null when
 *  its answer holds none that can be read. They take the oldest position of the
 *  ones they replace: consolidation makes long-term memory, and a recent position
 *  would make the engine treat it as covered by the visible history and mute it for
 *  dozens of turns. Two of them may say the same thing: adding them is what drops
 *  the second. */
export function planConsolidation(
  parsed: Record<string, unknown> | null,
  movable: readonly { source_position: number }[],
): Consolidation | null {
  const facts: Consolidation["facts"] = [];
  for (const item of items(parsed?.facts)) {
    if (isRecord(item) && textOf(item.content)) {
      facts.push({ content: textOf(item.content), kind: kindOf(item.kind) });
    }
  }
  if (!facts.length) return null;
  let oldest = movable.length ? movable[0].source_position : 0;
  for (const m of movable) oldest = Math.min(oldest, m.source_position);
  return { facts: facts.slice(0, MAX_CONSOLIDATED_FACTS), source_position: oldest };
}
