// What a prompt keeps for the reply, step for step `ceiling(...).reserve` of
// backend/app/services/ai_call.py, so that the page can say what an AI would read under a way
// without asking the server.

export interface ReserveModel {
  reply_cap_mode: "auto" | "unsent" | "fixed";
  reply_cap_tokens: number | null;
  /** 1 for a model that reasons. */
  reasons: number | null;
  /** The most the model writes, as its service says. */
  output_read: number | null;
}

// A connection with no ceiling has always kept 1024 for the reply, whatever length was asked.
const UNSENT_RESERVE = 1024;
// Anthropic refuses a request with no ceiling, so its provider always sends at least this.
const ANTHROPIC_FLOOR = 4096;
// A way that leaves the reply's room to the AI: the most the prompt keeps for it.
const OPEN_ROOM = 4096;

const atMost = (value: number, out: number | null) => (out === null ? value : Math.min(value, out));

/** What `auto` keeps, before the window's half. */
function autoReserve(
  model: ReserveModel,
  anthropic: boolean,
  room: number | null,
  window: number,
  allowance: number,
): number {
  const out = model.output_read;
  if (room === null) return Math.min(OPEN_ROOM, ...(out === null ? [] : [out]), Math.floor(window / 4));
  if (model.reasons === 1) {
    // Its thinking comes out of the same ceiling: what Anthropic is sent is all kept.
    if (anthropic) return atMost(Math.max(room + allowance, ANTHROPIC_FLOOR), out);
    return atMost(room + allowance, out);
  }
  if (anthropic) return atMost(Math.max(room, ANTHROPIC_FLOOR), out);
  // Whether it is sent or not (OpenAI's family is sent none), the room is what is kept.
  return atMost(room, out);
}

/** What the prompt budget keeps for the reply of this AI, for a way's room (null: left to the
 *  AI), over `window` tokens it is counted to read, with `allowance` for its thinking. The
 *  family decides only what is sent, which the server's copy also says; the reserve does not
 *  read it. */
export function replyReserve(
  model: ReserveModel,
  family: string,
  anthropic: boolean,
  room: number | null,
  window: number,
  allowance: number,
): number {
  if (model.reply_cap_mode === "fixed") return model.reply_cap_tokens as number;
  if (model.reply_cap_mode === "unsent") return UNSENT_RESERVE;
  // A reply that takes the whole window leaves the engine only its floor for the story.
  return Math.min(autoReserve(model, anthropic, room, window, allowance), Math.floor(window / 2));
}
