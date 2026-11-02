// What surrounds the prompt of one turn, a copy of backend/app/prompting/turn.py:
// the cases of parity/turn.json fail when it differs. Like the Python, none of it
// checks what it is given: the caller says the last message is a reply when
// continuing, and a position is a number.

import { activeContent, type ActiveMessage, type PromptPayload } from "./chat";
import { pyLstrip, pyRstrip } from "./text";

export const CONTINUE_INSTRUCTION =
  "[Continue your previous reply exactly where it stopped. Do not repeat anything, " +
  "do not start over \u2014 just keep going seamlessly.]";

/** Post-generation cleanup: drop anything the model wrote for the player, and a
 *  leading "Name:" speaker tag if present. The offsets are found and used on the
 *  same string, so counting in UTF-16 units where Python counts code points
 *  changes nothing. */
export function trimReply(text: string, charName: string, userName: string): string {
  let body = text;
  for (const marker of [`\n${userName}:`, `\n${userName} :`]) {
    const index = body.indexOf(marker);
    if (index !== -1) body = body.slice(0, index);
  }
  const stripped = pyLstrip(body);
  for (const prefix of [`${charName}:`, `${charName} :`]) {
    if (stripped.startsWith(prefix)) {
      body = pyLstrip(stripped.slice(prefix.length));
      break;
    }
  }
  return pyRstrip(body);
}

export interface ContinueTurn {
  role: "user";
  variants: string[];
  active_index: 0;
  position: number;
}

/** The history of a continuation: the chat, then an instruction from the player
 *  to carry on, one position after the reply that is being extended. Python
 *  raises on a null position; here a null one gives 1 and a missing one NaN,
 *  since the type says a position is a number. Only an empty list raises, in
 *  both. */
export function continueHistory<M extends { position: number }>(
  messages: readonly M[],
): (M | ContinueTurn)[] {
  return [
    ...messages,
    {
      role: "user",
      variants: [CONTINUE_INSTRUCTION],
      active_index: 0,
      position: messages[messages.length - 1].position + 1,
    },
  ];
}

/** The live scene, which facts and past messages are ranked against: the last
 *  couple of turns. */
export function sceneOf(history: readonly ActiveMessage[]): string {
  return history.slice(-2).map(activeContent).join("\n");
}

// Optional, since a payload with no statistics has no window and nothing is a
// candidate: Python's `.get(...) or 0` reads a null the same way, and so does this.
export type PassageStats = Pick<PromptPayload["stats"], "oldest_visible" | "fact_positions">;

/** The messages that recall may draw on, and the turns that a fact already
 *  covers, sorted since a set has no order to compare. `stats` is that of the
 *  payload built first: a message at or after its `oldest_visible` is still in
 *  the prompt. */
export function passageCandidates<M extends { position?: number | null }>(
  history: readonly M[],
  stats: PassageStats,
): { candidates: M[]; fact_positions: number[] } {
  const oldestVisible = stats.oldest_visible || 0;
  const covered = new Set<number>();
  for (const position of stats.fact_positions || []) {
    if (position !== null) covered.add(position);
  }
  return {
    candidates: history.filter((m) => (m.position || 0) < oldestVisible),
    fact_positions: [...covered].sort((a, b) => a - b),
  };
}

export interface PassageInfo {
  id: string;
  content: string;
  position: number;
  role: string;
}

/** What a candidate is, to the ranking of passages, for those that have a vector. */
export function passageInfos<
  M extends ActiveMessage & { id: string; role: string; position?: number | null },
>(candidates: readonly M[], ids: Iterable<string>): PassageInfo[] {
  const wanted = new Set(ids);
  return candidates
    .filter((m) => wanted.has(m.id))
    .map((m) => ({
      id: m.id,
      content: activeContent(m),
      position: m.position || 0,
      role: m.role,
    }));
}
