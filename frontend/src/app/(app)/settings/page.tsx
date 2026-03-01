"use client";

import {
  type GenerationParams,
  GENERATION_DEFAULTS,
  getGenerationParams,
  getSelectedProfile,
  saveSelectedProfile,
} from "@/lib/generation-params";
import { api } from "@/lib/api";
import type { Profile } from "@/types";
import PageContainer from "@/components/ui/PageContainer";
import ProfileDetailsSection from "@/components/settings/ProfileDetailsSection";
import GenerationParamsSection from "@/components/settings/GenerationParamsSection";
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
      <PageContainer>
        <h1 className="text-2xl font-bold mb-6">Settings</h1>
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="animate-pulse h-24 rounded-xl bg-surface-light"
            />
          ))}
        </div>
      </PageContainer>
    );
  }

  const active = profiles.find((p) => p.id === selectedProfile);

  return (
    <PageContainer>
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
                  : "border-border bg-surface hover:border-violet-500/30"
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
        <ProfileDetailsSection
          profile={active}
          saving={saving}
          onUpdateField={updateProfileField}
        />
      )}

      {/* Generation Parameters */}
      <GenerationParamsSection
        params={genParams}
        onChange={setGenParams}
      />
    </PageContainer>
  );
}
