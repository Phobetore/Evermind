import { Modal } from "@/components/ui/Modal";
import { data, type ServiceUpdate } from "@/data";
import { useT } from "@/i18n/useT";
import { describeError } from "@/lib/errors";
import type { Ai, ProviderType, Service } from "@/types";
import { Loader2 } from "lucide-react";
import { useId, useRef, useState } from "react";
import { KeyField } from "./AddAiFlow";

/** The same server either way, with or without its final "/" (the server's `bare`). */
const bare = (address: string) => address.trim().replace(/\/+$/, "");

/** Edits the service of an AI, for every AI on it: its name, address, key and type of API. An empty
 *  key keeps the saved one; "No key" forgets it. */
export function ServiceForm({ service, count, onSaved, onClose }: {
  service: Ai["service"];
  /** Its number of AIs, which a change reaches. */
  count: number;
  onSaved(service: Service): void;
  onClose(): void;
}) {
  const t = useT();
  const ids = useId();
  const [name, setName] = useState(service.name);
  const [address, setAddress] = useState(service.base_url);
  const [key, setKey] = useState("");
  const [noKey, setNoKey] = useState(false);
  const [provider, setProvider] = useState<ProviderType>(service.provider);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Read before the request is sent: two touches in one frame both arrive before the button is drawn disabled.
  const sending = useRef(false);

  async function save() {
    if (sending.current || !data.connections) return;
    const moved = bare(address) !== bare(service.base_url) || provider !== service.provider;
    // Said before anything is sent, as the server would refuse it: a saved key only goes where it was given.
    if (moved && service.api_key_set && !noKey && !key.trim()) {
      setError(t("errors.keyNeeded"));
      return;
    }
    const change: ServiceUpdate = {
      name: name.trim() || service.name,
      provider,
      base_url: address.trim(),
      api_key: noKey ? "" : key.trim() || null,
    };
    sending.current = true;
    setSaving(true);
    setError(null);
    try {
      onSaved(await data.connections.services.update(service.id, change));
      onClose();
    } catch (e) {
      setError(describeError(e, t));
    } finally {
      sending.current = false;
      setSaving(false);
    }
  }

  return (
    <Modal title={t("ai.service.title", { name: service.name })} onClose={onClose}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label className="flex flex-col gap-1.5 text-sm text-parchment-dim" htmlFor={`${ids}-name`}>
          {t("ai.service.name")}
          <input id={`${ids}-name`} className="field" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
        </label>
        <label className="flex flex-col gap-1.5 text-sm text-parchment-dim" htmlFor={`${ids}-address`}>
          {t("ai.add.addressLabel")}
          <input
            id={`${ids}-address`}
            className="field"
            type="text"
            inputMode="url"
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={address}
            onChange={(e) => setAddress(e.target.value)}
          />
        </label>
        <div className="flex flex-col gap-1.5">
          <label className="text-sm text-parchment-dim" htmlFor={`${ids}-key`}>{t("ai.service.key")}</label>
          {!noKey && (
            <KeyField
              id={`${ids}-key`}
              value={key}
              onChange={setKey}
              placeholder={service.api_key_set ? t("ai.service.keyKeep") : t("ai.add.addressKeyPlaceholder")}
            />
          )}
          {service.api_key_set && (
            <label className="touch-target flex cursor-pointer items-start gap-3 text-sm text-parchment-dim">
              <input
                type="checkbox"
                checked={noKey}
                onChange={(e) => setNoKey(e.target.checked)}
                className="mt-0.5 h-4 w-4 accent-[#e29a3e]"
              />
              <span>
                {t("ai.service.noKey")}
                <span className="block text-xs text-mist">{t("ai.service.noKeyHint")}</span>
              </span>
            </label>
          )}
        </div>
        <label className="flex flex-col gap-1.5 text-sm text-parchment-dim" htmlFor={`${ids}-type`}>
          {t("ai.service.type")}
          <select
            id={`${ids}-type`}
            className="field"
            value={provider}
            onChange={(e) => setProvider(e.target.value as ProviderType)}
          >
            <option value="openai-compatible">{t("ai.page.apiOpenai")}</option>
            <option value="anthropic">{t("ai.page.apiAnthropic")}</option>
          </select>
        </label>
        <p className="text-sm text-mist">{t("ai.service.forAll", { count })}</p>
        {error && <p role="alert" className="text-sm text-blood">{error}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className="btn btn-ghost" onClick={onClose}>{t("common.cancel")}</button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            {t("ai.service.save")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
