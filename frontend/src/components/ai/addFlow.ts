import type { ModelsCreate, SavedRef, ServiceDraft } from "@/data/types";
import type { Ai, Family, ProbeResult, ProviderType } from "@/types";

/** Where the flow was opened: from a conversation, the last AI ticked answers it. */
export type Origin = { from: "settings" } | { from: "conversation"; conversationId: string };

export interface Chip {
  family: Family;
  label: string;
  provider: ProviderType;
  base_url: string;
  local: boolean;
}

/** Servers that load a size of their own, and the paid services: the server's own two lists
 *  (catalog.LOCAL_FAMILIES, HOSTED_FAMILIES). */
export const LOCAL_FAMILIES: ReadonlySet<Family> = new Set(["ollama", "lmstudio", "llamacpp", "koboldcpp"]);
export const HOSTED_FAMILIES: ReadonlySet<Family> = new Set(["openrouter", "openai", "anthropic", "groq", "mistral"]);

/** The presets of the connection form before AIs, in its order, at the addresses each server
 *  listens on by default. */
export const CHIPS: Chip[] = [
  { family: "ollama", label: "Ollama", provider: "openai-compatible", base_url: "http://localhost:11434/v1", local: true },
  { family: "lmstudio", label: "LM Studio", provider: "openai-compatible", base_url: "http://localhost:1234/v1", local: true },
  { family: "llamacpp", label: "llama.cpp", provider: "openai-compatible", base_url: "http://localhost:8080/v1", local: true },
  { family: "koboldcpp", label: "KoboldCpp", provider: "openai-compatible", base_url: "http://localhost:5001/v1", local: true },
  { family: "openrouter", label: "OpenRouter", provider: "openai-compatible", base_url: "https://openrouter.ai/api/v1", local: false },
  { family: "openai", label: "OpenAI", provider: "openai-compatible", base_url: "https://api.openai.com/v1", local: false },
  { family: "anthropic", label: "Anthropic", provider: "anthropic", base_url: "https://api.anthropic.com", local: false },
  { family: "groq", label: "Groq", provider: "openai-compatible", base_url: "https://api.groq.com/openai/v1", local: false },
  { family: "mistral", label: "Mistral", provider: "openai-compatible", base_url: "https://api.mistral.ai/v1", local: false },
];

export type Step = "where" | "key" | "address" | "reading" | "failed" | "pick" | "done";

/** What the person told of a ticked model that its server did not. */
export interface Answer {
  context_own?: number | null;
  price_own_in?: number | null;
  price_own_out?: number | null;
}

export interface FlowError {
  kind: string;
  message: string;
}

export interface FlowState {
  step: Step;
  origin: Origin;
  serviceId: string | null;
  /** The service as it will be sent; for a saved one, its id, API and address, with no key. */
  draft: ServiceDraft | null;
  /** The chip it was reached by: its name, its family, whether it is local. */
  chip: Chip | null;
  /** Null at « pick » only after byHand: no row, the search field alone. */
  list: ProbeResult | null;
  /** A read that failed: at « failed », or above the list at « pick ». */
  error: FlowError | null;
  /** The failure that the key asked again, or the name by hand, was opened from: « Back » returns there. */
  failure: FlowError | null;
  /** An add, or a key saved, that failed: said above the foot. */
  addError: FlowError | null;
  /** « Add » or « Save the key » sent and not answered: the foot is disabled. */
  pending: boolean;
  /** The key was typed again by « Change the key » for a saved service. */
  newKey: boolean;
  /** That key is stored (« Save the key » answered). */
  keySaved: boolean;
  /** Ids in the order ticked; the last one answers from a conversation. */
  picked: string[];
  /** Ids added by « Use "q" as it is », shown as rows on top. */
  typed: string[];
  answers: Record<string, Answer>;
}

export type FlowEvent =
  | { type: "service"; id: string; provider: ProviderType; base_url: string }
  | { type: "chip"; chip: Chip }
  | { type: "other" }
  | { type: "key"; key: string }
  | { type: "address"; base_url: string; key: string }
  | { type: "read"; list: ProbeResult }
  | { type: "failed"; error: FlowError }
  | { type: "cancel" }
  // base_url: a local chip's address, put right under its failure.
  | { type: "retry"; base_url?: string }
  | { type: "byHand" }
  | { type: "back" }
  // A saved service whose key is refused: the key step, for that service.
  | { type: "newKey" }
  | { type: "pick"; id: string }
  | { type: "useAsIs"; id: string }
  | { type: "answer"; id: string; answer: Answer }
  | { type: "adding" }
  | { type: "added" }
  | { type: "addFailed"; error: FlowError }
  | { type: "keySaved" };

export function initial(origin: Origin): FlowState {
  return {
    step: "where", origin, serviceId: null, draft: null, chip: null, list: null, error: null, failure: null,
    addError: null, pending: false, newKey: false, keySaved: false, picked: [], typed: [], answers: {},
  };
}

/** The choice emptied: what was ticked, typed and answered belongs to one list. */
const unpicked: Pick<FlowState, "list" | "picked" | "typed" | "answers" | "error" | "addError"> = {
  list: null, picked: [], typed: [], answers: {}, error: null, addError: null,
};

/** The step a read was asked from, which « Cancel » goes back to. */
function beforeReading(state: FlowState): FlowState {
  if (state.newKey || (state.chip && !state.chip.local && state.serviceId === null)) {
    return { ...state, ...unpicked, step: "key" };
  }
  if (state.chip === null && state.serviceId === null) return { ...state, ...unpicked, step: "address" };
  return initial(state.origin);
}

/** A key asked again was opened from a failure, and gives it back. */
function backToFailure(state: FlowState): FlowState {
  // The key typed again is forgotten with its step.
  const draft = state.newKey && state.draft ? { ...state.draft } : state.draft;
  if (state.newKey && draft) delete draft.api_key;
  return { ...state, ...unpicked, step: "failed", error: state.failure, failure: null, newKey: false, draft };
}

export function reduce(state: FlowState, event: FlowEvent): FlowState {
  switch (event.type) {
    case "service":
      if (state.step !== "where") return state;
      return {
        ...initial(state.origin), step: "reading", serviceId: event.id,
        draft: { id: event.id, provider: event.provider, base_url: event.base_url },
      };
    case "chip": {
      if (state.step !== "where") return state;
      const { chip } = event;
      if (!chip.local) return { ...initial(state.origin), step: "key", chip };
      return {
        ...initial(state.origin), step: "reading", chip,
        draft: { provider: chip.provider, base_url: chip.base_url, family: chip.family },
      };
    }
    case "other":
      return state.step === "where" ? { ...initial(state.origin), step: "address" } : state;
    case "key": {
      const key = event.key.trim();
      if (state.step !== "key" || !key) return state;
      if (state.newKey && state.draft) return { ...state, step: "reading", draft: { ...state.draft, api_key: key } };
      if (!state.chip) return state;
      const { chip } = state;
      return {
        ...state, step: "reading",
        draft: { provider: chip.provider, base_url: chip.base_url, api_key: key, family: chip.family },
      };
    }
    case "address": {
      const base_url = event.base_url.trim();
      if (state.step !== "address" || !base_url) return state;
      return { ...state, step: "reading", draft: { provider: "openai-compatible", base_url, api_key: event.key.trim() } };
    }
    case "read":
      if (state.step === "pick") return { ...state, list: event.list, error: null };
      if (state.step !== "reading") return state;
      if (event.list.models.length === 0) {
        return { ...state, step: "failed", list: null, error: { kind: "list_empty", message: "" } };
      }
      return { ...state, step: "pick", list: event.list, error: null };
    case "failed":
      if (state.step === "reading") return { ...state, step: "failed", error: event.error };
      // A read again that fails keeps what is on screen.
      if (state.step === "pick" && state.list) return { ...state, error: event.error };
      return state;
    case "cancel":
      return state.step === "reading" ? beforeReading(state) : state;
    case "retry":
      if (state.step === "pick") return { ...state, error: null };
      if (state.step !== "failed") return state;
      return {
        ...state, step: "reading", error: null,
        draft: event.base_url?.trim() && state.draft ? { ...state.draft, base_url: event.base_url.trim() } : state.draft,
      };
    case "byHand":
      if (state.step !== "failed" || state.error?.kind === "model_auth_refused") return state;
      return { ...state, ...unpicked, step: "pick", failure: state.error };
    case "newKey":
      if (state.step !== "failed" || state.serviceId === null || state.error?.kind !== "model_auth_refused") return state;
      return { ...state, step: "key", newKey: true, failure: state.error, error: null };
    case "back":
      if (state.pending) return state;
      switch (state.step) {
        case "where":
          return state;
        case "key":
          return state.newKey ? backToFailure(state) : initial(state.origin);
        case "reading":
          return beforeReading(state);
        case "pick":
          if (state.list === null && state.failure) return backToFailure(state);
          if (state.newKey || (state.chip && !state.chip.local)) return { ...state, ...unpicked, step: "key" };
          return initial(state.origin);
        default:
          return initial(state.origin);
      }
    case "pick": {
      if (state.step !== "pick" || state.pending) return state;
      const ticked = state.picked.includes(event.id);
      return { ...state, picked: ticked ? state.picked.filter((id) => id !== event.id) : [...state.picked, event.id] };
    }
    case "useAsIs": {
      const id = event.id.trim();
      if (state.step !== "pick" || state.pending || !id) return state;
      const listed = state.list?.models.some((m) => m.id === id) ?? false;
      return {
        ...state,
        typed: listed || state.typed.includes(id) ? state.typed : [id, ...state.typed],
        picked: state.picked.includes(id) ? state.picked : [...state.picked, id],
      };
    }
    case "answer":
      return { ...state, answers: { ...state.answers, [event.id]: { ...state.answers[event.id], ...event.answer } } };
    case "adding": {
      const something = state.picked.length > 0 || (state.newKey && !state.keySaved);
      if (state.step !== "pick" || state.pending || !something) return state;
      return { ...state, pending: true, addError: null };
    }
    case "added":
      return state.pending ? { ...state, step: "done", pending: false } : state;
    case "addFailed":
      return { ...state, pending: false, addError: event.error };
    case "keySaved":
      return { ...state, pending: false, keySaved: true };
  }
}

/** How the service is named to the server: a saved one by its id, unless a key was typed again
 *  for it; with the family the read found, which keeps what the probes learned of an address. */
export function serviceRef(state: FlowState): SavedRef | ServiceDraft {
  const family = state.list?.family;
  const named = family ? { family } : {};
  if (state.serviceId !== null && !state.newKey) return { id: state.serviceId, ...named };
  return { ...(state.draft as ServiceDraft), ...named };
}

/** The only place the typed key goes into a request. A name typed as it is goes without a read. */
export function toCreate(state: FlowState): ModelsCreate {
  const models = state.picked.map((model) => {
    const read = state.typed.includes(model) ? undefined : state.list?.models.find((m) => m.id === model);
    const answer = Object.fromEntries(Object.entries(state.answers[model] ?? {}).filter(([, v]) => v !== undefined));
    return { model, ...(read ? { read } : {}), ...answer };
  });
  return {
    service: serviceRef(state),
    models,
    ...(state.origin.from === "conversation" ? { conversation_id: state.origin.conversationId } : {}),
  };
}

/** The model ids already added on the service the list is of, so that a key typed again for a
 *  saved service still marks them. */
export function have(state: FlowState, ais: Ai[]): Set<string> {
  const service = state.list?.service_id ?? state.serviceId;
  return new Set(service === null ? [] : ais.filter((ai) => ai.service.id === service).map((ai) => ai.model));
}

export type Foot =
  | { kind: "tick" }
  | { kind: "saveKey" }
  | { kind: "add"; count: number }
  | { kind: "answer"; count: number; last: string };

/** What the foot's button does: from a conversation, the last model still ticked answers there. */
export function footOf(state: FlowState): Foot {
  const count = state.picked.length;
  if (count === 0) return state.newKey && !state.keySaved ? { kind: "saveKey" } : { kind: "tick" };
  if (state.origin.from === "conversation") return { kind: "answer", count, last: state.picked[count - 1] };
  return { kind: "add", count };
}
