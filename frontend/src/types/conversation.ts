/** Conversation types — mirrors backend models. */

export interface Conversation {
  id: string;
  character_id: string;
  title: string;
  user_persona_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ConversationCreate {
  character_id: string;
  title?: string;
  user_persona_id?: string | null;
}
