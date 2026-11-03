// The face of the prompt engine: what an edition that talks to a model from the
// browser calls, and nothing more. The files behind it are the twin of
// backend/app/prompting/ and of what the services decide on a model's answer, and
// answer the cases in parity/ as the Python does. They import neither React nor
// anything of the interface, so this module can be taken whole.
//
// Small helpers stay behind it (Python's whitespace, the writer of JSON, the raw
// decoder): they exist for the files above, and exporting them would make a
// second way to do what a builder does. guards.test.ts holds this list.

export {
  activeContent,
  buildChatPayload,
  type ActiveMessage,
  type ChatInput,
  type ChatPayload,
  type PromptCharacter,
  type PromptConnection,
  type PromptConversation,
  type PromptLoreEntry,
  type PromptMemory,
  type PromptMessage,
  type PromptPassage,
  type PromptPayload,
  type PromptPersona,
  type PromptStats,
} from "./chat";
export { cleanCardDraft, type CardDraft, type DraftLoreEntry } from "./cardDraft";
export {
  CARD_ASSISTANT_PROMPT,
  DEFAULT_RP_RULES,
  IMPERSONATE_PROMPT,
  MEMORY_CONSOLIDATION_PROMPT,
  MEMORY_EXTRACTION_PROMPT,
  SCENARIO_RP_RULES,
  SUMMARIZE_PROMPT,
} from "./defaults";
export { parseLlmJson } from "./llmJson";
export { substitute } from "./macros";
export {
  planConsolidation,
  planCut,
  planMemoryChanges,
  type Checkpoint,
  type Consolidation,
  type CutFact,
  type CutMemory,
  type KnownFact,
  type MemoryChanges,
  type MemoryOp,
} from "./memoryChanges";
// The consolidation is asked for only above a number of facts, and only of those
// that `movableFacts` returns: whoever calls `buildConsolidationPayload` needs both.
export {
  MIN_FACTS_TO_CONSOLIDATE,
  buildCardPayload,
  buildConsolidationPayload,
  buildExtractionPayload,
  buildImpersonatePayload,
  buildSummaryPayload,
  movableFacts,
  type CardInput,
  type ConsolidationInput,
  type ExtractionInput,
  type ExtractionMessage,
  type ImpersonateInput,
  type SummaryInput,
} from "./payloads";
export { cosineScores, selectPassages, type RankedCandidate } from "./retrieval";
export { estimateTokens } from "./tokens";
export {
  continueHistory,
  passageCandidates,
  passageInfos,
  sceneOf,
  trimReply,
  type ContinueTurn,
  type PassageInfo,
  type PassageStats,
} from "./turn";
