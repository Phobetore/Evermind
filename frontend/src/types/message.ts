/** Message types — mirrors backend models. */

export interface Message {
  id: string;
  conversation_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  created_at: string;
  meta: MessageMeta;
}

/** Metadata attached to assistant messages (see Addendum §B.2). */
export interface AssistantMeta {
  schema_version: string;
  request_id: string;
  profile_id: string;
  pipeline: {
    best_of_n: number;
    self_refine: boolean;
    judge_enabled: boolean;
    memory_extract_enabled: boolean;
    memory_write_enabled: boolean;
  };
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  latency_ms: {
    dur_total: number;
    dur_generate: number;
    dur_judge: number;
    dur_self_refine: number;
    dur_memory_extract: number;
    dur_memory_write: number;
  };
  errors: string[];
}

export type MessageMeta = AssistantMeta | Record<string, unknown>;
