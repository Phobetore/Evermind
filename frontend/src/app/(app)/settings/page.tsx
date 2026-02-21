"use client";

import { api } from "@/lib/api";
import type { Profile } from "@/types";
import { useEffect, useState } from "react";

export default function SettingsPage() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedProfile, setSelectedProfile] = useState("balanced");

  useEffect(() => {
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
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) {
    return (
      <div className="p-6 max-w-4xl mx-auto">
        <h1 className="text-2xl font-bold mb-6">Settings</h1>
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="animate-pulse h-24 rounded-xl bg-zinc-800"
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
              onClick={() => setSelectedProfile(profile.id)}
              className={`text-left rounded-xl border p-4 transition-colors ${
                profile.id === selectedProfile
                  ? "border-blue-500 bg-blue-500/10"
                  : "border-zinc-800 bg-zinc-900 hover:border-zinc-700"
              }`}
            >
              <div className="flex items-center justify-between mb-2">
                <span className="font-medium capitalize">{profile.id}</span>
                {profile.id === selectedProfile && (
                  <span className="text-xs text-blue-400 font-medium">
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

      {/* Profile Details */}
      {active && (
        <section>
          <h2 className="text-lg font-semibold mb-4 text-zinc-200">
            Profile Details
          </h2>
          <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-5">
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
                <dt className="text-xs text-zinc-500 mb-1">Best-of-N</dt>
                <dd className="text-sm">{active.best_of_n}</dd>
              </div>
              <div>
                <dt className="text-xs text-zinc-500 mb-1">Self-refine</dt>
                <dd className="text-sm">
                  {active.self_refine ? "Enabled" : "Disabled"}
                </dd>
              </div>
            </dl>
          </div>
        </section>
      )}
    </div>
  );
}
