"use client";

import type { UserPersona, UserPersonaCreate } from "@/types";
import { api } from "@/lib/api";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Camera, Loader2 } from "lucide-react";

interface Props {
  initial?: UserPersona;
  onSubmit: (data: UserPersonaCreate) => Promise<void>;
}

export default function PersonaForm({ initial, onSubmit }: Props) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [name, setName] = useState(initial?.name ?? "");
  const [age, setAge] = useState(initial?.age ?? "");
  const [physicalDescription, setPhysicalDescription] = useState(
    initial?.physical_description ?? "",
  );
  const [personality, setPersonality] = useState(initial?.personality ?? "");
  const [backstory, setBackstory] = useState(initial?.backstory ?? "");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [avatarPath, setAvatarPath] = useState(initial?.avatar_path ?? "");
  const [avatarKey, setAvatarKey] = useState(0);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await onSubmit({
        name,
        age,
        physical_description: physicalDescription,
        personality,
        backstory,
        notes,
      });
      router.push("/personas");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function handleAvatarUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !initial) return;
    setUploading(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const resp = await fetch(`/api/user_personas/${initial.id}/avatar`, {
        method: "POST",
        body: formData,
      });
      if (!resp.ok) {
        const detail = await resp.text().catch(() => resp.statusText);
        throw new Error(`Upload failed: ${detail}`);
      }
      const updated = await resp.json();
      setAvatarPath(updated.avatar_path);
      setAvatarKey((k) => k + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function handleAvatarDelete() {
    if (!initial) return;
    try {
      await api.delete(`/user_personas/${initial.id}/avatar`);
      setAvatarPath("");
      setAvatarKey((k) => k + 1);
    } catch {
      // ignore
    }
  }

  return (
    <form onSubmit={handleSubmit} className="max-w-2xl space-y-6">
      {error && (
        <div className="rounded-lg bg-red-900/30 border border-red-800 p-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {/* Avatar section — only show for editing existing persona */}
      {initial && (
        <div className="flex items-center gap-4">
          <div className="relative group">
            {avatarPath ? (
              <img
                key={avatarKey}
                src={`/api/user_personas/${initial.id}/avatar/file?v=${avatarKey}`}
                alt={name}
                className="h-20 w-20 rounded-full object-cover border-2 border-border"
              />
            ) : (
              <div className="flex items-center justify-center h-20 w-20 rounded-full bg-violet-600 font-medium text-2xl border-2 border-border">
                {name.charAt(0).toUpperCase() || "?"}
              </div>
            )}
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="absolute inset-0 flex items-center justify-center rounded-full bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity"
              title="Change avatar"
            >
              {uploading ? (
                <Loader2 size={20} className="animate-spin text-white" />
              ) : (
                <Camera size={20} className="text-white" />
              )}
            </button>
          </div>
          <div className="space-y-1">
            <p className="text-sm text-zinc-300">Profile Picture</p>
            <p className="text-xs text-zinc-500">Optional. JPEG, PNG, WebP, GIF (max 5 MB).</p>
            {avatarPath && (
              <button
                type="button"
                onClick={handleAvatarDelete}
                className="text-xs text-red-400 hover:text-red-300 transition-colors"
              >
                Remove picture
              </button>
            )}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif"
            className="hidden"
            onChange={handleAvatarUpload}
          />
        </div>
      )}

      <Field label="Name" required>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          maxLength={200}
          className="input"
          placeholder="Your persona name"
        />
      </Field>

      <Field label="Age">
        <input
          type="text"
          value={age}
          onChange={(e) => setAge(e.target.value)}
          className="input"
          placeholder="e.g. 25, mid-twenties"
        />
      </Field>

      <Field label="Physical Description">
        <textarea
          value={physicalDescription}
          onChange={(e) => setPhysicalDescription(e.target.value)}
          className="input min-h-[100px]"
          placeholder="Height, build, hair color, eye color, distinguishing features…"
        />
      </Field>

      <Field label="Personality">
        <textarea
          value={personality}
          onChange={(e) => setPersonality(e.target.value)}
          className="input min-h-[80px]"
          placeholder="Traits, demeanor, how you interact…"
        />
      </Field>

      <Field label="Backstory">
        <textarea
          value={backstory}
          onChange={(e) => setBackstory(e.target.value)}
          className="input min-h-[80px]"
          placeholder="Background, history, relevant context…"
        />
      </Field>

      <Field label="Notes">
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          className="input min-h-[60px]"
          placeholder="Anything else characters should know about you…"
        />
      </Field>

      <div className="flex gap-3">
        <button
          type="submit"
          disabled={saving || !name.trim()}
          className="rounded-lg bg-violet-600 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-violet-500 disabled:opacity-50"
        >
          {saving ? "Saving…" : initial ? "Update" : "Create"}
        </button>
        <button
          type="button"
          onClick={() => router.push("/personas")}
          className="rounded-lg border border-border px-5 py-2.5 text-sm text-zinc-300 hover:bg-surface-light transition-colors"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium text-zinc-300">
        {label}
        {required && <span className="text-red-400 ml-1">*</span>}
      </span>
      {children}
    </label>
  );
}
