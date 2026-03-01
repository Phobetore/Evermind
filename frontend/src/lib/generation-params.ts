/** Generation parameters — persistence via localStorage. */

export type QualityMode = "balanced" | "immersive" | "fast";

export interface GenerationParams {
  temperature: number;
  top_p: number;
  max_tokens: number;
  best_of_n: number;
  self_refine: boolean;
  repeat_penalty: number;
  quality_mode: QualityMode;
}

const STORAGE_KEY = "evermind_generation_params";
const PROFILE_KEY = "evermind_selected_profile";
const DEFAULT_PROFILE = "balanced";

export const QUALITY_MODE_PRESETS: Record<QualityMode, Omit<GenerationParams, "quality_mode">> = {
  balanced: {
    temperature: 0.72,
    top_p: 0.9,
    max_tokens: 900,
    best_of_n: 3,
    self_refine: true,
    repeat_penalty: 1.08,
  },
  immersive: {
    temperature: 0.78,
    top_p: 0.92,
    max_tokens: 1100,
    best_of_n: 5,
    self_refine: true,
    repeat_penalty: 1.12,
  },
  fast: {
    temperature: 0.68,
    top_p: 0.88,
    max_tokens: 700,
    best_of_n: 1,
    self_refine: false,
    repeat_penalty: 1.04,
  },
};

const DEFAULTS: GenerationParams = {
  ...QUALITY_MODE_PRESETS.balanced,
  quality_mode: "balanced",
};

function asQualityMode(value: unknown): QualityMode | null {
  if (value === "balanced" || value === "immersive" || value === "fast") {
    return value;
  }
  return null;
}

export function getGenerationParams(): GenerationParams {
  if (typeof window === "undefined") return { ...DEFAULTS };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const mode = asQualityMode(parsed.quality_mode) ?? DEFAULTS.quality_mode;
    const preset = QUALITY_MODE_PRESETS[mode];

    return {
      quality_mode: mode,
      temperature: typeof parsed.temperature === "number" ? parsed.temperature : preset.temperature,
      top_p: typeof parsed.top_p === "number" ? parsed.top_p : preset.top_p,
      max_tokens: typeof parsed.max_tokens === "number" ? parsed.max_tokens : preset.max_tokens,
      best_of_n: typeof parsed.best_of_n === "number" ? parsed.best_of_n : preset.best_of_n,
      self_refine: typeof parsed.self_refine === "boolean" ? parsed.self_refine : preset.self_refine,
      repeat_penalty: typeof parsed.repeat_penalty === "number" ? parsed.repeat_penalty : preset.repeat_penalty,
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

export function applyQualityMode(mode: QualityMode): GenerationParams {
  return {
    quality_mode: mode,
    ...QUALITY_MODE_PRESETS[mode],
  };
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
