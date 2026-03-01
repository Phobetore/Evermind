/** Message types — mirrors backend models. */

export interface Message {
  id: string;
  conversation_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  created_at: string;
  meta: MessageMeta;
}

export interface AssistantQualitySignals {
  response_chars: number;
  response_words: number;
  unique_words: number;
  lexical_diversity: number;
  repetition_ratio: number;
  memory_items_injected: number;
}

/** Metadata attached to assistant messages (see Addendum §B.2 + local extensions). */
export interface AssistantMeta {
  schema_version?: string;
  request_id?: string;
  profile_id?: string;
  pipeline?: {
    best_of_n?: number;
    self_refine?: boolean;
    quality_mode?: string;
    judge_enabled?: boolean;
    memory_extract_enabled?: boolean;
    memory_write_enabled?: boolean;
  };
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  latency_ms?: {
    dur_total?: number;
    dur_generate?: number;
    dur_judge?: number;
    dur_self_refine?: number;
    dur_memory_extract?: number;
    dur_memory_write?: number;
  };
  quality_signals?: Partial<AssistantQualitySignals>;
  retrieval?: {
    top_k?: number;
    selected_n?: number;
    memory_ids_selected?: string[];
    scoring?: {
      method?: string;
      formula?: string;
      strategy?: string;
      weight_importance?: number;
      weight_confidence?: number;
    };
    memory_summaries?: Array<{
      id: string;
      rank?: number;
      type?: string;
      title?: string;
      importance?: number;
      confidence?: number;
      score?: number;
    }>;
  };
  errors?: string[];
}

export type MessageMeta = AssistantMeta | Record<string, unknown>;
