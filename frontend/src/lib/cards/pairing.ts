import type { LoreEntryInput } from "@/data";

// Which entry of a card made before is each entry of the character now. A pairing in doubt is no
// pairing: a wrong one hands another entry's settings (always on, place, depth) to the entry
// without a word, and makes the export write over the wrong entry of the card; an entry left
// alone keeps its own behaviour exactly, and only loses, at the export, what the card held of the
// entry it came from.
//
// The two numbers below are measures, not bounds: random cards of real sentences on two corpora
// (English, French and Japanese, 370,000 entries), whose entries share their keys and are
// retouched every way a person retouches (a word, both ends, every third word, sentences added or
// cut, split, merged, keys changed, typos, case, pronouns, line breaks), beside entries written
// here under the keys of others.
// - An entry written here under the keys of another was up to 0.375 alike to it. With 0.36, 0.37
//   and 0.38 as the floor, 3, 2 and 0 such entries took another's settings; with 0.40 an entry
//   retouched at both ends ("She hums at night." become "Mirela hums at dawn.", 0.388) loses its
//   own. Another hand's prose may go past 0.38: under the floor, two texts are no more alike than
//   two written apart, on these corpora only.
// - Of the gaps tried between the best and a rival with as many keys in common, 0.15 left one
//   entry with another's settings, 0.2 none; 0.25 leaves 10,344 entries unpaired against 9,035.
// Two shapes stay that no number tells apart, as their texts do not: lines on one frame that
// differ by a number ("Guard: level 3…"), and a few words of an entry of before written here as an
// entry of their own under its keys, which is that entry cut down for all its text says.
const LEAST = 0.38;
const MARGIN = 0.2;

/** Texts are compared by their runs of four neighbouring characters: by pairs, two texts about the
 *  same character share a third of theirs whoever wrote them, and by threes an entry written here
 *  can still pass the floor ("Vane left the company the night before Garrow Ford." beside "The
 *  northern campaign ended at Garrow Ford, where…": 0.445 by threes, 0.348 by fours). */
const RUN = 4;

/** A text as the measure reads it, its runs counted once for every comparison it is in. */
interface Text {
  /** Its characters, as code points: one outside the basic plane is one character, not two halves. */
  chars: string[];
  runs: Map<string, number>;
}

function textOf(content: string): Text {
  const chars = Array.from(content.trim());
  return { chars, runs: runsOf(chars, RUN) };
}

function runsOf(chars: string[], length: number): Map<string, number> {
  const runs = new Map<string, number>();
  for (let i = 0; i + length <= chars.length; i++) {
    let run = chars[i];
    for (let k = 1; k < length; k++) run += chars[i + k];
    runs.set(run, (runs.get(run) ?? 0) + 1);
  }
  return runs;
}

/** How many runs two texts have in common, each counted as often as it comes in both. */
function sharedRuns(one: Map<string, number>, other: Map<string, number>): number {
  const [small, large] = one.size <= other.size ? [one, other] : [other, one];
  let shared = 0;
  for (const [run, count] of small) shared += Math.min(count, large.get(run) ?? 0);
  return shared;
}

/** How alike two texts are, from 0 to 1, wherever what they share is and however much was written
 *  around it, by the runs they have in common, counted with repeats. Half the score is the share
 *  of the runs of both, 2 x shared / (runs of one + runs of the other), what a retouch keeps; half
 *  is the share of the runs of the shorter, which an entry keeps whole when sentences were added
 *  around it, or when it was cut down to one of its own. A text of four characters or fewer is a
 *  single run (of its own length, when shorter than four), and for it the second half says only
 *  whether those few characters come somewhere in the other, which "a", "old", "17" or "eyes" do
 *  by chance: for a single run only the share of both counts. */
function alike(one: Text, other: Text): number {
  const length = Math.min(RUN, one.chars.length, other.chars.length);
  if (length === 0) return one.chars.length === other.chars.length ? 1 : 0;
  const shared = length === RUN ? sharedRuns(one.runs, other.runs) : sharedRuns(runsOf(one.chars, length), runsOf(other.chars, length));
  const runsOfOne = one.chars.length - length + 1;
  const runsOfOther = other.chars.length - length + 1;
  const both = (2 * shared) / (runsOfOne + runsOfOther);
  const fewest = Math.min(runsOfOne, runsOfOther);
  return fewest === 1 ? both : both / 2 + shared / (2 * fewest);
}

/** How alike two texts are, from 0 to 1, as the pairing weighs them. */
export function likeness(one: string, other: string): number {
  return alike(textOf(one), textOf(other));
}

/** Keys as a set: their order, or one written twice, changes nothing to what they match. */
const keySet = (keys: string[]) => JSON.stringify([...new Set(keys)].sort());

/** The entry of before each entry of the character is, if any, on what the two still share, never
 *  on rank alone, and never in doubt. First an entry that already names its origin (one kept with
 *  its card before). Then the same keys (as a set) and the same text, never in doubt: the first not
 *  taken. Then, among the entries of before not taken that share its keys (as a set) or its text
 *  and are at least LEAST alike, the one with the most keys in common, then the most alike text.
 *  It is taken only when no rival puts it in doubt (one with as many keys in common within MARGIN
 *  of it; one whose text is the entry's own, when the best's is not: one entry by its keys and
 *  another by its very text cannot both be it), and when the entry is, by the same rule, the clear
 *  best of that entry of before. A pair settled removes its two entries from the others' rivals,
 *  and the rest is weighed again until nothing more settles. An entry of before left alone was
 *  deleted by its owner; an entry of the character left alone was made here, rewritten past
 *  recognition, or could be taken for two. */
export function pairEntries(current: LoreEntryInput[], old: LoreEntryInput[]): (LoreEntryInput | null)[] {
  const taken = new Set<number>();
  const paired: (LoreEntryInput | null)[] = current.map(() => null);
  const oldKeys = old.map((entry) => keySet(entry.keys));
  const nowKeys = current.map((entry) => keySet(entry.keys));
  const oldText = old.map((entry) => entry.content.trim());
  const nowText = current.map((entry) => entry.content.trim());

  // An entry that already names its origin: one kept with its card before.
  current.forEach((entry, i) => {
    if (entry.origin === null) return;
    const at = old.findIndex((candidate, j) => !taken.has(j) && candidate.origin === entry.origin);
    if (at < 0) return;
    taken.add(at);
    paired[i] = old[at];
  });

  // The same keys and the same text: never in doubt, the first not taken in the card's order.
  const byKeys = new Map<string, number[]>();
  const byText = new Map<string, number[]>();
  const file = (into: Map<string, number[]>, under: string, j: number) => {
    const list = into.get(under);
    if (list) list.push(j);
    else into.set(under, [j]);
  };
  old.forEach((_, j) => {
    file(byKeys, oldKeys[j], j);
    file(byText, oldText[j], j);
  });
  current.forEach((_, i) => {
    if (paired[i]) return;
    const at = (byKeys.get(nowKeys[i]) ?? []).find((j) => !taken.has(j) && oldText[j] === nowText[i]);
    if (at === undefined) return;
    taken.add(at);
    paired[i] = old[at];
  });

  interface Candidate { i: number; j: number; keys: number; alike: number; same: boolean }
  const byEntry = current.map((): Candidate[] => []);
  const byOld = old.map((): Candidate[] => []);
  const oldTexts: (Text | undefined)[] = [];
  current.forEach((entry, i) => {
    if (paired[i]) return;
    const near = new Set([...(byKeys.get(nowKeys[i]) ?? []), ...(byText.get(nowText[i]) ?? [])]);
    if (near.size === 0) return;
    const text = textOf(entry.content);
    const ownKeys = new Set(entry.keys);
    for (const j of near) {
      if (taken.has(j)) continue;
      const likeness = alike(text, (oldTexts[j] ??= textOf(old[j].content)));
      if (likeness < LEAST) continue;
      const found: Candidate = {
        i, j, keys: new Set(old[j].keys.filter((key) => ownKeys.has(key))).size, alike: likeness, same: oldText[j] === nowText[i],
      };
      byEntry[i].push(found);
      byOld[j].push(found);
    }
  });
  const open = (found: Candidate) => !paired[found.i] && !taken.has(found.j);
  /** The best of a list, unless a rival puts it in doubt: one with as many keys in common within
   *  MARGIN of it, or one whose text is the same when the best's is not. */
  const clearBest = (list: Candidate[]) => {
    let best: Candidate | null = null;
    for (const found of list) {
      if (!best || found.keys > best.keys || (found.keys === best.keys && found.alike > best.alike)) best = found;
    }
    if (!best) return null;
    const doubt = list.some((found) => found !== best
      && ((found.keys === best.keys && best.alike - found.alike < MARGIN) || (found.same && !best.same)));
    return doubt ? null : best;
  };
  // A pair settled only takes rivals away from the others, never adds one: what is clear stays
  // clear, and the result does not depend on the order the entries are weighed in.
  for (let settled = true; settled;) {
    settled = false;
    current.forEach((_, i) => {
      if (paired[i]) return;
      const best = clearBest(byEntry[i].filter(open));
      if (!best || clearBest(byOld[best.j].filter(open)) !== best) return;
      taken.add(best.j);
      paired[i] = old[best.j];
      settled = true;
    });
  }
  return paired;
}
