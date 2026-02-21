/** Memory types for future memory inspector (v1.0). */

export interface MemoryItem {
  id: string;
  character_id: string;
  type: "semantic" | "episodic" | "world";
  title: string;
  content: string;
  entities: string[];
  tags: string[];
  importance: number;
  confidence: number;
  is_pinned: boolean;
  is_deleted: boolean;
  created_at: string;
  last_referenced_at: string | null;
  source_turn_id: string | null;
}
