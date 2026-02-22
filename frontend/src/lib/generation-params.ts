/** Generation parameters — persistence via localStorage. */

export interface GenerationParams {
  temperature: number;
  top_p: number;
  max_tokens: number;
}

const STORAGE_KEY = "evermind_generation_params";
const PROFILE_KEY = "evermind_selected_profile";
const DEFAULT_PROFILE = "balanced";

const DEFAULTS: GenerationParams = {
  temperature: 0.7,
  top_p: 0.9,
  max_tokens: 800,
};

export function getGenerationParams(): GenerationParams {
  if (typeof window === "undefined") return { ...DEFAULTS };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveGenerationParams(params: Partial<GenerationParams>): void {
  if (typeof window === "undefined") return;
  const current = getGenerationParams();
  const merged = { ...current, ...params };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
}

export const GENERATION_DEFAULTS = DEFAULTS;

export function getSelectedProfile(): string {
  if (typeof window === "undefined") return DEFAULT_PROFILE;
  return localStorage.getItem(PROFILE_KEY) || DEFAULT_PROFILE;
}

export function saveSelectedProfile(profileId: string): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(PROFILE_KEY, profileId);
}
