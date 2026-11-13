// The engine's only door: what the rest of the application may call. Nothing here is
// called yet; the cases of backend/tests/cases/ reach every function it offers.

export {
  buildChatPayload,
  matchLore,
  selectFacts,
  activeContent,
  isOutOfCharacter,
  stripThought,
  trimReply,
} from "./chat";
export { keyMatches, stripDecorators } from "./lorebook";
export {
  buildImpersonatePayload,
  buildExtractionPayload,
  buildConsolidationPayload,
  buildCardPayload,
  words,
  MIN_FACTS_TO_CONSOLIDATE,
} from "./payloads";
export {
  planMemoryChanges,
  planConsolidation,
  isMovable,
  movableFacts,
  answerTexts,
  MAX_TURNS_PER_RUN,
} from "./memoryChanges";
export { parseLlmJson, partialJson } from "./llmJson";
export { cleanCardDraft, withRoomForACard } from "./cardDraft";
export { substitute, substituteOriginal, hasOriginalMacro } from "./macros";
export { estimateTokens } from "./tokens";
export * from "./defaults";
export { CONTINUE_INSTRUCTION, autoTitle } from "./chat";
export type { PromptPayload, PromptStats, ChatInput, PromptMemory, PromptLoreEntry } from "./chat";
export type { MemoryPlan, KnownFact } from "./memoryChanges";
