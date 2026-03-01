"use client";

import type { Profile } from "@/types";
import Card from "@/components/ui/Card";

interface Props {
  profile: Profile;
  saving: boolean;
  onUpdateField: (field: string, value: number | boolean) => void;
}

/** Details and controls for the active generation profile. */
export default function ProfileDetailsSection({ profile, saving, onUpdateField }: Props) {
  return (
    <section className="mb-8">
      <h2 className="text-lg font-semibold mb-4 text-zinc-200">
        Profile Details
        {saving && (
          <span className="ml-2 text-xs text-zinc-500 font-normal">Saving…</span>
        )}
      </h2>
      <Card className="space-y-6">
        <dl className="grid gap-4 sm:grid-cols-2">
          <div>
            <dt className="text-xs text-zinc-500 mb-1">Chat Server</dt>
            <dd className="text-sm">{profile.chat_server}</dd>
          </div>
          <div>
            <dt className="text-xs text-zinc-500 mb-1">Memory Server</dt>
            <dd className="text-sm">{profile.memory_server}</dd>
          </div>
          <div>
            <dt className="text-xs text-zinc-500 mb-1">Judge Server</dt>
            <dd className="text-sm">{profile.judge_server}</dd>
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
              {profile.best_of_n}
            </span>
          </div>
          <input
            type="range"
            min={1}
            max={7}
            step={1}
            value={profile.best_of_n}
            onChange={(e) =>
              onUpdateField("best_of_n", parseInt(e.target.value))
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
              onUpdateField("self_refine", !profile.self_refine)
            }
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
              profile.self_refine ? "bg-violet-500" : "bg-border"
            }`}
            role="switch"
            aria-checked={profile.self_refine}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                profile.self_refine ? "translate-x-6" : "translate-x-1"
              }`}
            />
          </button>
        </div>
      </Card>
    </section>
  );
}
