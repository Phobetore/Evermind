"use client";

import {
  type GenerationParams,
  GENERATION_DEFAULTS,
  saveGenerationParams,
} from "@/lib/generation-params";
import Card from "@/components/ui/Card";

interface Props {
  params: GenerationParams;
  onChange: (params: GenerationParams) => void;
}

/** Slider controls for temperature, top_p, and max_tokens. */
export default function GenerationParamsSection({ params, onChange }: Props) {
  function update<K extends keyof GenerationParams>(key: K, value: GenerationParams[K]) {
    const updated = { ...params, [key]: value };
    onChange(updated);
    saveGenerationParams(updated);
  }

  return (
    <section>
      <h2 className="text-lg font-semibold mb-4 text-zinc-200">
        Generation Parameters
      </h2>
      <p className="text-sm text-zinc-400 mb-4">
        Fine-tune how the LLM generates responses. Changes are saved automatically.
      </p>

      <Card className="space-y-6">
        {/* Temperature */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-sm font-medium text-zinc-300">
              Temperature
            </label>
            <span className="text-sm text-zinc-400 tabular-nums">
              {params.temperature.toFixed(2)}
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={2}
            step={0.05}
            value={params.temperature}
            onChange={(e) => update("temperature", parseFloat(e.target.value))}
            className="w-full accent-violet-500"
          />
          <div className="flex justify-between text-xs text-zinc-500 mt-1">
            <span>Precise</span>
            <span>Creative</span>
          </div>
        </div>

        {/* Top P */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-sm font-medium text-zinc-300">
              Top P
            </label>
            <span className="text-sm text-zinc-400 tabular-nums">
              {params.top_p.toFixed(2)}
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={params.top_p}
            onChange={(e) => update("top_p", parseFloat(e.target.value))}
            className="w-full accent-violet-500"
          />
          <div className="flex justify-between text-xs text-zinc-500 mt-1">
            <span>Focused</span>
            <span>Diverse</span>
          </div>
        </div>

        {/* Max Tokens */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-sm font-medium text-zinc-300">
              Max Tokens
            </label>
            <span className="text-sm text-zinc-400 tabular-nums">
              {params.max_tokens}
            </span>
          </div>
          <input
            type="range"
            min={100}
            max={4096}
            step={100}
            value={params.max_tokens}
            onChange={(e) => update("max_tokens", parseInt(e.target.value))}
            className="w-full accent-violet-500"
          />
          <div className="flex justify-between text-xs text-zinc-500 mt-1">
            <span>Short (100)</span>
            <span>Long (4096)</span>
          </div>
        </div>

        {/* Reset button */}
        <button
          onClick={() => {
            const defaults = { ...GENERATION_DEFAULTS };
            onChange(defaults);
            saveGenerationParams(defaults);
          }}
          className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
        >
          Reset to defaults
        </button>
      </Card>
    </section>
  );
}
