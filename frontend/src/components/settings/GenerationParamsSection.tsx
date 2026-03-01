"use client";

import {
  type GenerationParams,
  type QualityMode,
  applyQualityMode,
  GENERATION_DEFAULTS,
  saveGenerationParams,
} from "@/lib/generation-params";
import Card from "@/components/ui/Card";

interface Props {
  params: GenerationParams;
  onChange: (params: GenerationParams) => void;
}

const MODE_INFO: Record<QualityMode, { title: string; desc: string }> = {
  balanced: {
    title: "Balanced",
    desc: "Good quality/latency tradeoff for daily use.",
  },
  immersive: {
    title: "Immersive",
    desc: "Best narrative depth and coherence (slower).",
  },
  fast: {
    title: "Fast",
    desc: "Low latency and lighter compute cost.",
  },
};

/** Slider controls for generation quality and coherence knobs. */
export default function GenerationParamsSection({ params, onChange }: Props) {
  function update<K extends keyof GenerationParams>(key: K, value: GenerationParams[K]) {
    const updated = { ...params, [key]: value };
    onChange(updated);
    saveGenerationParams(updated);
  }

  function setQualityMode(mode: QualityMode) {
    const updated = applyQualityMode(mode);
    onChange(updated);
    saveGenerationParams(updated);
  }

  return (
    <section>
      <h2 className="text-lg font-semibold mb-4 text-zinc-200">Generation Parameters</h2>
      <p className="text-sm text-zinc-400 mb-4">
        Use quality modes for quick tuning, then fine-adjust individual controls.
      </p>

      <Card className="space-y-6">
        <div>
          <p className="text-xs uppercase tracking-wider text-zinc-500 mb-3">Quality mode</p>
          <div className="grid gap-2 md:grid-cols-3">
            {(Object.keys(MODE_INFO) as QualityMode[]).map((mode) => {
              const info = MODE_INFO[mode];
              const isActive = params.quality_mode === mode;
              return (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setQualityMode(mode)}
                  className={`rounded-xl border p-3 text-left transition-colors ${
                    isActive
                      ? "border-violet-500 bg-violet-500/10"
                      : "border-border bg-surface hover:border-violet-500/30"
                  }`}
                >
                  <p className="text-sm font-medium text-zinc-100">{info.title}</p>
                  <p className="text-xs text-zinc-400 mt-1">{info.desc}</p>
                </button>
              );
            })}
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm font-medium text-zinc-300">Temperature</label>
              <span className="text-sm text-zinc-400 tabular-nums">{params.temperature.toFixed(2)}</span>
            </div>
            <input type="range" min={0.1} max={1.5} step={0.05} value={params.temperature} onChange={(e) => update("temperature", parseFloat(e.target.value))} className="w-full accent-violet-500" />
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm font-medium text-zinc-300">Top P</label>
              <span className="text-sm text-zinc-400 tabular-nums">{params.top_p.toFixed(2)}</span>
            </div>
            <input type="range" min={0.5} max={1} step={0.05} value={params.top_p} onChange={(e) => update("top_p", parseFloat(e.target.value))} className="w-full accent-violet-500" />
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm font-medium text-zinc-300">Max Tokens</label>
              <span className="text-sm text-zinc-400 tabular-nums">{params.max_tokens}</span>
            </div>
            <input type="range" min={200} max={4096} step={100} value={params.max_tokens} onChange={(e) => update("max_tokens", parseInt(e.target.value))} className="w-full accent-violet-500" />
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm font-medium text-zinc-300">Best-of-N</label>
              <span className="text-sm text-zinc-400 tabular-nums">{params.best_of_n}</span>
            </div>
            <input type="range" min={1} max={7} step={1} value={params.best_of_n} onChange={(e) => update("best_of_n", parseInt(e.target.value))} className="w-full accent-violet-500" />
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm font-medium text-zinc-300">Repeat Penalty</label>
              <span className="text-sm text-zinc-400 tabular-nums">{params.repeat_penalty.toFixed(2)}</span>
            </div>
            <input type="range" min={1} max={1.3} step={0.01} value={params.repeat_penalty} onChange={(e) => update("repeat_penalty", parseFloat(e.target.value))} className="w-full accent-violet-500" />
          </div>

          <label className="rounded-xl border border-border bg-surface-light/40 px-4 py-3 flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-zinc-200">Self-refine pass</p>
              <p className="text-xs text-zinc-400">Run a final rewrite using judge suggestions.</p>
            </div>
            <input
              type="checkbox"
              checked={params.self_refine}
              onChange={(e) => update("self_refine", e.target.checked)}
              className="h-4 w-4 accent-violet-500"
            />
          </label>
        </div>

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
