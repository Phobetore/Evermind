/** Character types — mirrors backend Pydantic models. */

export interface ExampleDialogue {
  user: string;
  assistant: string;
}

export interface MemorySeed {
  content: string;
  type: string;
  importance: number;
}

export interface Character {
  id: string;
  name: string;
  tags: string[];
  summary: string;
  persona: string;
  writing_style: string;
  scenario: string;
  first_message: string;
  example_dialogues: ExampleDialogue[];
  boundaries: string;
  system_rules: string;
  memory_seed: MemorySeed[];
  created_at: string;
  updated_at: string;
}

export interface CharacterCreate {
  name: string;
  tags?: string[];
  summary?: string;
  persona?: string;
  writing_style?: string;
  scenario?: string;
  first_message?: string;
  example_dialogues?: ExampleDialogue[];
  boundaries?: string;
  system_rules?: string;
  memory_seed?: MemorySeed[];
}

export type CharacterUpdate = Partial<CharacterCreate>;
