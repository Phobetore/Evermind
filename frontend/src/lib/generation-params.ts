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
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    // Only pick known generation-param keys so that stale or unexpected
    // fields (e.g. best_of_n, self_refine) never leak into the request
    // and accidentally override profile settings.
    return {
      temperature: typeof parsed.temperature === "number" ? parsed.temperature : DEFAULTS.temperature,
      top_p: typeof parsed.top_p === "number" ? parsed.top_p : DEFAULTS.top_p,
      max_tokens: typeof parsed.max_tokens === "number" ? parsed.max_tokens : DEFAULTS.max_tokens,
    };
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
