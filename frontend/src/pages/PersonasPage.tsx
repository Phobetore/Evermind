import { Field } from "@/components/editor/Field";
import { Avatar } from "@/components/ui/Avatar";
import { EmptyState } from "@/components/ui/EmptyState";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { Modal } from "@/components/ui/Modal";
import { Tag } from "@/components/ui/Tag";
import { data } from "@/data";
import { useT } from "@/i18n/useT";
import { describeError } from "@/lib/errors";
import type { Persona } from "@/types";
import { Plus, Trash2, UserRound } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export function PersonasPage() {
  const t = useT();
  const [personas, setPersonas] = useState<Persona[] | null>(null);
  const [editing, setEditing] = useState<Persona | "new" | null>(null);
  const [failure, setFailure] = useState<{ error: unknown } | null>(null);

  const load = () =>
    data.personas.list().then((list) => {
      setPersonas(list);
      setFailure(null);
    }, (error) => setFailure({ error }));
  useEffect(() => {
    load();
  }, []);

  // Read again however it closes: a save that failed partway may have made one.
  function close() {
    setEditing(null);
    load();
  }

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

      {failure ? (
        <LoadFailure error={failure.error} onRetry={load} />
      ) : personas === null ? (
        <div className="text-mist animate-pulse-soft">{t("common.loading")}</div>
      ) : personas.length === 0 ? (
        <EmptyState icon={UserRound} title={t("personas.emptyState.title")}>
          {t("personas.emptyState.body")}
        </EmptyState>
      ) : (
        <div className="stagger grid grid-cols-1 gap-4 sm:grid-cols-2">
          {personas.map((p) => (
            <button
              key={p.id}
              onClick={() => setEditing(p)}
              className="panel flex items-start gap-4 p-5 text-left transition-colors hover:border-ember-600/40"
            >
              <Avatar name={p.name} src={p.avatar_url} className="h-14 w-14 shrink-0 text-xl" />
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h2 className="min-w-0 break-words font-display text-lg font-semibold">{p.name}</h2>
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
        <PersonaModal persona={editing === "new" ? null : editing} onClose={close} />
      )}
    </div>
  );
}

function PersonaModal({ persona, onClose }: { persona: Persona | null; onClose: () => void }) {
  const t = useT();
  const [name, setName] = useState(persona?.name ?? "");
  const [description, setDescription] = useState(persona?.description ?? "");
  const [isDefault, setIsDefault] = useState(persona?.is_default ?? false);
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = useState(persona?.avatar_url ?? null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  // A save that fails partway has made the new persona already.
  const created = useRef("");

  async function save() {
    if (!name.trim()) {
      setError(t("personas.nameRequired"));
      return;
    }
    setSaving(true);
    try {
      const body = { name, description, is_default: isDefault };
      const id = persona?.id || created.current;
      const saved = id
        ? await data.personas.update(id, body)
        : await data.personas.create(body);
      created.current = saved.id;
      // The first persona is made the default whatever was asked, which saving again must not undo.
      setIsDefault(saved.is_default);
      if (avatarFile) await data.personas.uploadAvatar(saved.id, avatarFile);
      onClose();
    } catch (e) {
      setError(describeError(e, t, t("personas.saveError")));
      setSaving(false);
    }
  }

  async function remove() {
    if (!persona) return;
    if (!confirm(t("personas.confirmDelete", { name: persona.name }))) return;
    try {
      await data.personas.remove(persona.id);
      onClose();
    } catch (e) {
      setError(describeError(e, t));
    }
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
