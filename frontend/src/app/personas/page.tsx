"use client";

import { Field } from "@/components/editor/Field";
import { Avatar } from "@/components/ui/Avatar";
import { EmptyState } from "@/components/ui/EmptyState";
import { Modal } from "@/components/ui/Modal";
import { Tag } from "@/components/ui/Tag";
import { useT } from "@/i18n/useT";
import { api } from "@/lib/api";
import type { Persona } from "@/types";
import { Plus, Trash2, UserRound } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export default function PersonasPage() {
  const t = useT();
  const [personas, setPersonas] = useState<Persona[] | null>(null);
  const [editing, setEditing] = useState<Persona | "new" | null>(null);

  const load = () => api.get<Persona[]>("/api/personas").then(setPersonas);
  useEffect(() => {
    load();
  }, []);

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <header className="mb-8 flex items-center justify-between animate-rise">
        <div>
          <h1 className="font-display text-3xl font-semibold">{t("nav.personas")}</h1>
          <p className="mt-1 text-mist">{t("personas.subtitle")}</p>
        </div>
        <button className="btn btn-primary" onClick={() => setEditing("new")}>
          <Plus className="h-4 w-4" /> {t("personas.newPersona")}
        </button>
      </header>

      {personas === null ? (
        <div className="text-mist animate-pulse-soft">{t("common.loading")}</div>
      ) : personas.length === 0 ? (
        <EmptyState icon={UserRound} title={t("personas.emptyState.title")}>
          {t("personas.emptyState.body")}
        </EmptyState>
      ) : (
        <div className="stagger grid gap-4 sm:grid-cols-2">
          {personas.map((p) => (
            <button
              key={p.id}
              onClick={() => setEditing(p)}
              className="panel flex items-start gap-4 p-5 text-left transition-colors hover:border-ember-600/40"
            >
              <Avatar name={p.name} src={p.avatar_url} className="h-14 w-14 shrink-0 text-xl" />
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h3 className="font-display text-lg font-semibold">{p.name}</h3>
                  {p.is_default && <Tag tone="ember">{t("personas.defaultTag")}</Tag>}
                </div>
                <p className="mt-1 line-clamp-3 text-sm leading-relaxed text-mist">
                  {p.description || t("personas.noDescription")}
                </p>
              </div>
            </button>
          ))}
        </div>
      )}

      {editing && (
        <PersonaModal
          persona={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
    </div>
  );
}

function PersonaModal({
  persona,
  onClose,
  onSaved,
}: {
  persona: Persona | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useT();
  const [name, setName] = useState(persona?.name ?? "");
  const [description, setDescription] = useState(persona?.description ?? "");
  const [isDefault, setIsDefault] = useState(persona?.is_default ?? false);
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = useState(persona?.avatar_url ?? null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  async function save() {
    if (!name.trim()) {
      setError(t("personas.nameRequired"));
      return;
    }
    setSaving(true);
    try {
      const body = { name, description, is_default: isDefault };
      const saved = persona
        ? await api.put<Persona>(`/api/personas/${persona.id}`, body)
        : await api.post<Persona>("/api/personas", body);
      if (avatarFile) await api.upload(`/api/personas/${saved.id}/avatar`, avatarFile);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("personas.saveError"));
      setSaving(false);
    }
  }

  async function remove() {
    if (!persona) return;
    if (!confirm(t("personas.confirmDelete", { name: persona.name }))) return;
    await api.delete(`/api/personas/${persona.id}`);
    onSaved();
  }

  return (
    <Modal
      title={persona ? t("personas.editTitle", { name: persona.name }) : t("personas.newPersona")}
      onClose={onClose}
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            className="h-16 w-16 shrink-0 overflow-hidden rounded-full border border-ink-600 transition-colors hover:border-ember-500"
            aria-label={t("personas.avatarLabel")}
          >
            <Avatar
              name={name || "?"}
              src={avatarPreview}
              className="h-full w-full text-xl"
              rounded="rounded-none"
            />
          </button>
          <input
            ref={fileInput}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) {
                setAvatarFile(f);
                setAvatarPreview(URL.createObjectURL(f));
              }
            }}
          />
          <div className="flex-1">
            <Field label={t("personas.nameLabel")}>
              <input className="field" value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
          </div>
        </div>

        <Field label={t("personas.descriptionLabel")} hint={t("personas.descriptionHint")}>
          <textarea
            className="field min-h-28"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>

        <label className="flex cursor-pointer items-center gap-2.5 text-sm text-parchment-dim">
          <input
            type="checkbox"
            checked={isDefault}
            onChange={(e) => setIsDefault(e.target.checked)}
            className="h-4 w-4 accent-[#e29a3e]"
          />
          {t("personas.useAsDefaultLabel")}
        </label>

        {error && (
          <p className="rounded-lg border border-blood/40 bg-blood/10 px-4 py-2.5 text-sm text-blood">
            {error}
          </p>
        )}

        <div className="flex items-center justify-between pt-2">
          {persona ? (
            <button className="btn btn-danger" onClick={remove}>
              <Trash2 className="h-4 w-4" /> {t("common.delete")}
            </button>
          ) : (
            <span />
          )}
          <button className="btn btn-primary" onClick={save} disabled={saving}>
            {saving ? "…" : t("common.save")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
