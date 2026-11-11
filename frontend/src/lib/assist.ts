/** The card assistant's job, as the page follows it: which job it has begun, how to keep asking the
 *  server how it stands, and what its end means for the form. Nothing here touches the page. */

import { data, DataError, type Asking, type AssistField, type AssistState, type CharacterInput } from "@/data";
import type { Translate } from "@/i18n/I18nProvider";
import { describeFailure, isUnanswered } from "@/lib/errors";
import { newId } from "@/lib/utils";
import type { Kind } from "@/types";

const PREFIX = "evermind:assist:";

/** The card's fields the assistant writes, in the order the form shows them. */
export const ASSIST_FIELDS: readonly AssistField[] = [
  "name", "tagline", "description", "personality", "scenario", "greeting",
  "alternate_greetings", "example_dialogues", "tags", "lore_entries",
];

/** A job begun from this page, with what it was asked for: the brief goes back in its box. */
export interface RememberedJob {
  id: string;
  brief: string;
  kind: Kind;
}

/** What a card is called while it is not saved: there is one such card in the form at a time. */
export const scopeOf = (cardId: string | undefined) => cardId || "new";

/** Writes a job down for a card, so that a page that is reloaded, left, or put to sleep by a phone
 *  can find it again. */
export function rememberJob(scope: string, job: RememberedJob): void {
  try {
    localStorage.setItem(PREFIX + scope, JSON.stringify(job));
  } catch {
    /* quota exceeded or storage disabled: the job still runs, it is only not found again */
  }
}

export function rememberedJob(scope: string): RememberedJob | null {
  try {
    const kept = JSON.parse(localStorage.getItem(PREFIX + scope) ?? "null");
    if (typeof kept?.id !== "string" || typeof kept?.brief !== "string") return null;
    return { id: kept.id, brief: kept.brief, kind: kept.kind === "scenario" ? "scenario" : "character" };
  } catch {
    return null; // nothing readable was kept, or storage this site may not use
  }
}

export function forgetJob(scope: string): void {
  try {
    localStorage.removeItem(PREFIX + scope);
  } catch {
    /* storage this site may not use has nothing to clear */
  }
}

/** Moves what is remembered for a card not saved yet to the card it has become, so that the job
 *  follows it and the next new card does not find it. */
export function moveJob(from: string, to: string): void {
  const job = rememberedJob(from);
  if (!job) return;
  rememberJob(to, job);
  forgetJob(from);
}

/** The id a start goes out under. A start whose answer was lost may have begun a job all the same:
 *  asked again under the same id for the same brief, the server answers with that job. */
export function clientIdFor(
  lost: { clientId: string; brief: string } | null,
  brief: string,
  draw: () => string = newId,
): string {
  return lost && lost.brief === brief ? lost.clientId : draw();
}

export const POLL_MS = 1_000;
export const PATIENCE_MS = 10_000;
/** After a request that got no answer: this, then twice that, and so on up to the longest wait. */
export const RETRY_MS = 2_000;
export const LONGEST_RETRY_MS = 8_000;

/** How the following ended. It never throws: a page that has stopped following (`aborted`) has
 *  nothing to be told. */
export type Followed =
  | { kind: "ended"; state: AssistState }
  /** The server does not know the job (any more). */
  | { kind: "gone" }
  | { kind: "failed"; error: unknown }
  | { kind: "aborted" };

export interface FollowOptions {
  /** Ends the following: the job goes on, on the server. */
  signal: AbortSignal;
  /** Each state the server gave, the last of them the job's end. */
  onState: (state: AssistState) => void;
  /** Whether a request to Evermind has failed for want of an answer and is being tried again. */
  onWaiting: (waiting: boolean) => void;
  /** How the server is asked; the page's own data source unless a test puts another. */
  state?: (id: string, asking: Asking) => Promise<AssistState>;
}

/** Asks how the job stands every second while it runs, until it ends. A question that gets no answer
 *  is asked again later each time, and the page coming back to sight, or the network back, asks at
 *  once; any other failure ends the following. */
export async function follow(id: string, options: FollowOptions): Promise<Followed> {
  const { signal, onState, onWaiting, state = data.characters.assist.state } = options;
  let wake: (() => void) | null = null;
  const pause = (ms: number) =>
    new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        wake = null;
        resolve();
      };
      const timer = setTimeout(done, ms);
      wake = done;
    });
  const comingBack = () => {
    if (globalThis.document?.visibilityState !== "hidden") wake?.();
  };
  const stop = () => wake?.();
  globalThis.document?.addEventListener("visibilitychange", comingBack);
  globalThis.addEventListener?.("online", comingBack);
  signal.addEventListener("abort", stop);
  try {
    let failures = 0;
    while (!signal.aborted) {
      try {
        const now = await state(id, { signal, within: PATIENCE_MS });
        if (signal.aborted) break;
        failures = 0;
        onWaiting(false);
        onState(now);
        if (!now.running) return { kind: "ended", state: now };
        await pause(POLL_MS);
      } catch (error) {
        if (signal.aborted) break;
        if (error instanceof DataError && error.kind === "not_found") return { kind: "gone" };
        if (!isUnanswered(error)) return { kind: "failed", error };
        onWaiting(true);
        await pause(Math.min(RETRY_MS * 2 ** failures, LONGEST_RETRY_MS));
        failures += 1;
      }
    }
    return { kind: "aborted" };
  } finally {
    globalThis.document?.removeEventListener("visibilitychange", comingBack);
    globalThis.removeEventListener?.("online", comingBack);
    signal.removeEventListener("abort", stop);
  }
}

/** What the end of a job means for the form. */
export interface AssistOutcome {
  /** The card's own fields to put over the form's. */
  fields: Partial<CharacterInput>;
  /** Lorebook entries to add to the book. */
  lore: { keys: string[]; content: string }[];
  /** The fields asked for that did not come. */
  missing: AssistField[];
  /** The model ran out of room. */
  cut: boolean;
  stopped: boolean;
  error: AssistState["error"];
}

export function outcome(state: AssistState): AssistOutcome {
  const { lore_entries: lore = [], ...fields } = state.draft ?? {};
  return { fields, lore, missing: state.missing, cut: state.cut, stopped: state.stopped, error: state.error };
}

const isEmpty = (value: unknown) =>
  typeof value === "string" ? !value.trim() : Array.isArray(value) ? value.length === 0 : value == null;

/** Of the fields a job wrote, those the form can take now: the draft holds the creator's fields as
 *  they were when the job began, so a field is taken only if it is still empty in the form. */
export function fieldsToTake(form: Partial<CharacterInput>, fields: Partial<CharacterInput>): Partial<CharacterInput> {
  return Object.fromEntries(
    Object.entries(fields).filter(([key]) => isEmpty(form[key as keyof CharacterInput])),
  ) as Partial<CharacterInput>;
}

/** Whether anything of the card came. */
export const kept = (ended: AssistOutcome) => Object.keys(ended.fields).length > 0 || ended.lore.length > 0;

/** What the model is doing at this moment, as far as the server can tell. */
export type Situation =
  | { kind: "waiting" }
  | { kind: "thinking"; thought: number }
  | { kind: "writing"; field: AssistField }
  | { kind: "between" };

/** What the panel shows of a job under way. */
export interface Progress {
  /** The card's fields in the form's order, each told whether it is complete. */
  fields: { field: AssistField; done: boolean }[];
  /** Lorebook entries complete so far, which the lorebook's chip counts. */
  lore: number;
  situation: Situation;
}

export function progress(state: Pick<AssistState, "fields" | "lore" | "written" | "thought" | "writing">): Progress {
  const done = new Set(state.fields);
  const writing = state.writing && ASSIST_FIELDS.includes(state.writing) ? state.writing : null;
  let situation: Situation;
  if (state.written === 0) {
    situation = state.thought > 0 ? { kind: "thinking", thought: state.thought } : { kind: "waiting" };
  } else {
    situation = writing ? { kind: "writing", field: writing } : { kind: "between" };
  }
  return {
    fields: ASSIST_FIELDS.map((field) => ({ field, done: done.has(field) })),
    lore: state.lore,
    situation,
  };
}

/** Seconds as a clock: "0:42", "12:05". */
export function formatClock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** The sentence under the block once a job has ended, or null when everything arrived. A failure
 *  is said first, then what is missing: pressing Generate again writes only that, since the fields
 *  that are filled are kept and the server asks for the rest. `label` is the name the form gives a field. */
export function describeOutcome(
  ended: AssistOutcome,
  t: Translate,
  label: (field: AssistField) => string,
): string | null {
  const said: string[] = [];
  if (ended.error) said.push(describeFailure({ kind: ended.error.kind, message: ended.error.error }, t));
  if (ended.missing.length > 0) {
    const key = ended.cut ? "missingCut" : ended.stopped ? "missingStopped" : "missing";
    said.push(t(`characters.assist.${key}`, { fields: ended.missing.map(label).join(", ") }));
  }
  return said.length > 0 ? said.join(" ") : null;
}
