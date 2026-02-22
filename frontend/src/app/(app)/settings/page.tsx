"use client";

import {
  type GenerationParams,
  GENERATION_DEFAULTS,
  getGenerationParams,
  getSelectedProfile,
  saveGenerationParams,
  saveSelectedProfile,
} from "@/lib/generation-params";
import { api } from "@/lib/api";
import type { Profile } from "@/types";
import { useCallback, useEffect, useState } from "react";

export default function SettingsPage() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedProfile, setSelectedProfile] = useState("balanced");
  const [genParams, setGenParams] = useState<GenerationParams>(GENERATION_DEFAULTS);
  const [saving, setSaving] = useState(false);

  const loadProfiles = useCallback(() => {
    api
      .get<Profile[]>("/profiles")
      .then((data) => {
        setProfiles(data);
        if (data.length > 0 && !data.find((p) => p.id === selectedProfile)) {
          setSelectedProfile(data[0].id);
        }
      })
      .catch(() => setProfiles([]))
      .finally(() => setLoading(false));
  }, [selectedProfile]);

  useEffect(() => {
    setGenParams(getGenerationParams());
    setSelectedProfile(getSelectedProfile());
    loadProfiles();
  }, [loadProfiles]);

  function updateParam<K extends keyof GenerationParams>(key: K, value: GenerationParams[K]) {
    const updated = { ...genParams, [key]: value };
    setGenParams(updated);
    saveGenerationParams(updated);
  }

  async function updateProfileField(field: string, value: number | boolean) {
    const active = profiles.find((p) => p.id === selectedProfile);
    if (!active) return;
    setSaving(true);
    try {
      const updated = await api.put<Profile>(`/profiles/${active.id}`, {
        [field]: value,
      });
      setProfiles((prev) =>
        prev.map((p) => (p.id === updated.id ? updated : p))
      );
    } catch {
      // Silently ignore — the backend may not persist changes to disk
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="p-6 max-w-4xl mx-auto">
        <h1 className="text-2xl font-bold mb-6">Settings</h1>
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="animate-pulse h-24 rounded-xl bg-[#1e1a2e]"
            />
          ))}
        </div>
      </div>
    );
  }

  const active = profiles.find((p) => p.id === selectedProfile);

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold mb-6">Settings</h1>

      {/* Generation Profiles */}
      <section className="mb-8">
        <h2 className="text-lg font-semibold mb-4 text-zinc-200">
          Generation Profiles
        </h2>
        <p className="text-sm text-zinc-400 mb-4">
          Select a profile to control how responses are generated.
        </p>

        <div className="grid gap-3 sm:grid-cols-2">
          {profiles.map((profile) => (
            <button
              key={profile.id}
              onClick={() => {
                setSelectedProfile(profile.id);
                saveSelectedProfile(profile.id);
              }}
              className={`text-left rounded-xl border p-4 transition-colors ${
                profile.id === selectedProfile
                  ? "border-violet-500 bg-violet-500/10"
                  : "border-[#2a2440] bg-[#14111f] hover:border-violet-500/30"
              }`}
            >
              <div className="flex items-center justify-between mb-2">
                <span className="font-medium capitalize">{profile.id}</span>
                {profile.id === selectedProfile && (
                  <span className="text-xs text-violet-400 font-medium">
                    Active
                  </span>
                )}
              </div>
              <div className="flex gap-3 text-xs text-zinc-400">
                <span>Best-of-N: {profile.best_of_n}</span>
                <span>·</span>
                <span>
                  Self-refine: {profile.self_refine ? "On" : "Off"}
                </span>
              </div>
            </button>
          ))}
        </div>
      </section>

      {/* Profile Details & Controls */}
      {active && (
        <section className="mb-8">
          <h2 className="text-lg font-semibold mb-4 text-zinc-200">
            Profile Details
            {saving && (
              <span className="ml-2 text-xs text-zinc-500 font-normal">Saving…</span>
            )}
          </h2>
          <div className="rounded-xl border border-[#2a2440] bg-[#14111f] p-5 space-y-6">
            <dl className="grid gap-4 sm:grid-cols-2">
              <div>
                <dt className="text-xs text-zinc-500 mb-1">Chat Server</dt>
                <dd className="text-sm">{active.chat_server}</dd>
              </div>
              <div>
                <dt className="text-xs text-zinc-500 mb-1">Memory Server</dt>
                <dd className="text-sm">{active.memory_server}</dd>
              </div>
              <div>
                <dt className="text-xs text-zinc-500 mb-1">Judge Server</dt>
                <dd className="text-sm">{active.judge_server}</dd>
              </div>
              <div>
                <dt className="text-xs text-zinc-500 mb-1">Context Window</dt>
                <dd className="text-sm text-zinc-400">8,192 tokens (chat default)</dd>
              </div>
            </dl>

            {/* Best-of-N Slider */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-sm font-medium text-zinc-300">
                  Best-of-N
                </label>
                <span className="text-sm text-zinc-400 tabular-nums">
                  {active.best_of_n}
                </span>
              </div>
              <input
                type="range"
                min={1}
                max={7}
                step={1}
                value={active.best_of_n}
                onChange={(e) =>
                  updateProfileField("best_of_n", parseInt(e.target.value))
                }
                className="w-full accent-violet-500"
              />
              <div className="flex justify-between text-xs text-zinc-500 mt-1">
                <span>Single (1)</span>
                <span>Max quality (7)</span>
              </div>
              <p className="text-xs text-zinc-500 mt-1">
                Generate N candidate responses and pick the best one using the
                judge model.
              </p>
            </div>

            {/* Self-refine Toggle */}
            <div className="flex items-center justify-between">
              <div>
                <label className="text-sm font-medium text-zinc-300">
                  Self-refine
                </label>
                <p className="text-xs text-zinc-500 mt-0.5">
                  After selecting the best candidate, refine it using the
                  judge&apos;s suggestions.
                </p>
              </div>
              <button
                onClick={() =>
                  updateProfileField("self_refine", !active.self_refine)
                }
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                  active.self_refine ? "bg-violet-500" : "bg-[#2a2440]"
                }`}
                role="switch"
                aria-checked={active.self_refine}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                    active.self_refine ? "translate-x-6" : "translate-x-1"
                  }`}
                />
              </button>
            </div>
          </div>
        </section>
      )}

      {/* Generation Parameters */}
      <section>
        <h2 className="text-lg font-semibold mb-4 text-zinc-200">
          Generation Parameters
        </h2>
        <p className="text-sm text-zinc-400 mb-4">
          Fine-tune how the LLM generates responses. Changes are saved automatically.
        </p>

        <div className="rounded-xl border border-[#2a2440] bg-[#14111f] p-5 space-y-6">
          {/* Temperature */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm font-medium text-zinc-300">
                Temperature
              </label>
              <span className="text-sm text-zinc-400 tabular-nums">
                {genParams.temperature.toFixed(2)}
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={2}
              step={0.05}
              value={genParams.temperature}
              onChange={(e) => updateParam("temperature", parseFloat(e.target.value))}
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
                {genParams.top_p.toFixed(2)}
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={genParams.top_p}
              onChange={(e) => updateParam("top_p", parseFloat(e.target.value))}
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
                {genParams.max_tokens}
              </span>
            </div>
            <input
              type="range"
              min={100}
              max={4096}
              step={100}
              value={genParams.max_tokens}
              onChange={(e) => updateParam("max_tokens", parseInt(e.target.value))}
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
              setGenParams({ ...GENERATION_DEFAULTS });
              saveGenerationParams(GENERATION_DEFAULTS);
            }}
            className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            Reset to defaults
          </button>
        </div>
      </section>
    </div>
  );
}
