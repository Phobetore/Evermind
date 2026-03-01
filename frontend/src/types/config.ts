/** Configuration / profile types. */

export interface Profile {
  id: string;
  chat_server: string;
  memory_server: string;
  judge_server: string;
  best_of_n: number;
  self_refine: boolean;
}

/** Mapping of server key (e.g. "chat") → model name (e.g. "gemma-3-12b-it-heretic"). */
export type ServerModels = Record<string, string>;
