/** User Persona types — mirrors backend Pydantic models. */

export interface UserPersona {
  id: string;
  name: string;
  age: string;
  physical_description: string;
  personality: string;
  backstory: string;
  notes: string;
  avatar_path: string;
  created_at: string;
  updated_at: string;
}

export interface UserPersonaCreate {
  name: string;
  age?: string;
  physical_description?: string;
  personality?: string;
  backstory?: string;
  notes?: string;
}

export type UserPersonaUpdate = Partial<UserPersonaCreate>;
