import { useConfirm } from "@/components/ui/Confirm";
import { Modal } from "@/components/ui/Modal";
import { data, DataError, type DataSource } from "@/data";
import type { Translate } from "@/i18n/I18nProvider";
import { useT } from "@/i18n/useT";
import { describeError } from "@/lib/errors";
import type { Ai, Conversation, Family, Service } from "@/types";
import { ChevronRight, Loader2 } from "lucide-react";
import { useEffect, useId, useReducer, useRef, useState } from "react";
import {
  CHIPS, HOSTED_FAMILIES, LOCAL_FAMILIES, footOf, have, initial, reduce, serviceRef, toCreate,
  type Chip, type FlowError, type FlowEvent, type FlowState, type Origin,
} from "./addFlow";
import { ModelPickList } from "./ModelPickList";

type Connections = NonNullable<DataSource["connections"]>;

/** A key field that does not offer to keep what is typed: a password field would have the browser
 *  propose to store the key in its own synced manager, and "it stays on your PC" would be untrue.
 *  Masked where the browser can (Chrome, Safari); elsewhere it shows, on the person's own screen. */
const KEY_FIELD = {
  type: "text",
  autoComplete: "off",
  autoCapitalize: "none",
  autoCorrect: "off",
  spellCheck: false,
  className: "field [-webkit-text-security:disc]",
} as const;

/** Adding AIs: where the service runs, its key once, then any of its models. Nothing is written
 *  before the foot's button, but the removal of a service that holds no AI; closing forgets the
 *  key typed and the list read. */
export function AddAiFlow({ origin, onAdded, onClose }: {
  origin: Origin;
  onAdded(result: { service: Service; models: Ai[]; conversation: Conversation | null }): void;
  onClose(): void;
}) {
  const t = useT();
  // Drawn only where the edition keeps its own models.
  const connections = data.connections as Connections;
  const [state, dispatch] = useReducer(reduce, origin, initial);
  const [services, setServices] = useState<Service[] | null>(null);
  const [ais, setAis] = useState<Ai[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rereading, setRereading] = useState(false);
  // One read at a time: the one asked last is the only one whose answer counts.
  const reading = useRef<AbortController | null>(null);
  // Read before the request is sent: two touches in one frame both arrive before the button is
  // drawn disabled, on the slow link most of all.
  const sending = useRef(false);

  useEffect(() => {
    Promise.all([connections.services.list(), connections.models.list()]).then(
      ([listed, models]) => {
        setServices(listed);
        setAis(models);
      },
      (error) => {
        setServices([]);
        setLoadError(describeError(error, t));
      },
    );
  }, [connections, t]);

  // A read still on its way is given up with the dialog.
  useEffect(() => () => reading.current?.abort(), []);

  function errorOf(error: unknown): FlowError {
    return { kind: error instanceof DataError ? error.kind ?? "unexpected" : "unexpected", message: describeError(error, t) };
  }

  /** Asks the server for the list, for the state the flow is now in. */
  function read(next: FlowState, fresh: boolean) {
    reading.current?.abort();
    const controller = new AbortController();
    reading.current = controller;
    const inPlace = next.step === "pick";
    if (inPlace) setRereading(true);
    connections.probe(serviceRef(next), { fresh, asking: { signal: controller.signal } }).then(
      (list) => {
        if (!controller.signal.aborted) dispatch({ type: "read", list });
      },
      (error) => {
        if (!controller.signal.aborted) dispatch({ type: "failed", error: errorOf(error) });
      },
    ).finally(() => {
      if (reading.current === controller) {
        reading.current = null;
        setRereading(false);
      }
    });
  }

  /** An event of the person's, and the read it leads to. */
  function go(event: FlowEvent) {
    const next = reduce(state, event);
    if (next === state) return;
    if (state.step === "reading" || (state.step === "pick" && next.step !== "pick")) {
      reading.current?.abort();
      reading.current = null;
      setRereading(false);
    }
    dispatch(event);
    if (next.step === "reading" && state.step !== "reading") read(next, false);
  }

  function reread() {
    if (state.step !== "pick" || !state.list) return;
    dispatch({ type: "retry" });
    read(state, true);
  }

  async function confirmFoot() {
    const foot = footOf(state);
    if (sending.current || foot.kind === "tick") return;
    sending.current = true;
    dispatch({ type: "adding" });
    try {
      if (foot.kind === "saveKey") {
        await connections.services.update(state.serviceId as string, { api_key: state.draft?.api_key ?? null });
        dispatch({ type: "keySaved" });
      } else {
        const result = await connections.models.create(toCreate(state));
        setAis((before) => [...before.filter((ai) => !result.models.some((made) => made.id === ai.id)), ...result.models]);
        dispatch({ type: "added" });
        onAdded(result);
      }
    } catch (error) {
      dispatch({ type: "addFailed", error: errorOf(error) });
    } finally {
      sending.current = false;
    }
  }

  const saved = state.serviceId ? services?.find((s) => s.id === state.serviceId) ?? null : null;
  const family: Family = state.list?.family ?? state.chip?.family ?? saved?.family ?? "generic";
  const name = state.chip?.label ?? saved?.name ?? null;

  return (
    <Modal title={t("ai.add.title")} onClose={onClose} wide tall>
      {state.step === "where" && (
        <Where services={services} loadError={loadError} connections={connections} onChoose={go} />
      )}
      {state.step === "key" && (
        <KeyStep
          service={name ?? ""}
          initialKey={state.draft?.api_key ?? ""}
          onKey={(key) => go({ type: "key", key })}
          onBack={() => go({ type: "back" })}
        />
      )}
      {state.step === "address" && (
        <AddressStep
          initialAddress={state.draft?.base_url ?? ""}
          initialKey={state.draft?.api_key ?? ""}
          onAddress={(base_url, key) => go({ type: "address", base_url, key })}
          onBack={() => go({ type: "back" })}
        />
      )}
      {state.step === "reading" && (
        <div className="flex flex-col items-start gap-4 py-4" role="status">
          <p className="flex items-center gap-2 text-parchment-dim">
            <Loader2 className="h-5 w-5 animate-spin" />
            {name ? t("ai.add.reading", { service: name }) : t("ai.add.readingServer")}
          </p>
          <button type="button" className="btn btn-ghost" onClick={() => go({ type: "cancel" })}>
            {t("common.cancel")}
          </button>
        </div>
      )}
      {state.step === "failed" && state.error && (
        <Failed
          state={state}
          line={failureLine(state.error, state, name, family, t)}
          onEvent={go}
        />
      )}
      {state.step === "pick" && (
        <Pick
          state={state}
          name={name}
          family={family}
          have={have(state, ais)}
          rereading={rereading}
          failure={state.error && failureLine(state.error, state, name, family, t)}
          onEvent={(event) => dispatch(event)}
          onReread={reread}
          onBack={() => go({ type: "back" })}
          onConfirm={confirmFoot}
        />
      )}
      {state.step === "done" && (
        <div className="flex flex-col items-start gap-3" role="status">
          <p className="font-display text-lg font-semibold">{t("ai.add.done", { count: state.picked.length })}</p>
          <p className="text-sm text-mist">{t("ai.add.doneHint", { count: state.picked.length })}</p>
          <button type="button" className="btn btn-primary mt-2" onClick={onClose}>
            {t("ai.add.backToSettings")}
          </button>
        </div>
      )}
    </Modal>
  );
}

/** The sentence for a read that failed, naming the service and, for one at home, its address. */
function failureLine(error: FlowError, state: FlowState, name: string | null, family: Family, t: Translate): string {
  const service = name ?? t("ai.add.theServer");
  const address = state.draft?.base_url ?? "";
  switch (error.kind) {
    case "unreachable":
      if (state.chip?.local || (state.chip === null && LOCAL_FAMILIES.has(family))) {
        return t("ai.add.unreachableLocal", { service, address });
      }
      if (HOSTED_FAMILIES.has(family)) return t("ai.add.unreachableHosted", { service });
      return t("ai.add.unreachableOther", { service, address });
    case "list_timeout":
      return t("ai.add.timeout", { service });
    case "model_auth_refused":
      return t("ai.add.keyRefused", { service });
    case "model_rate_limited":
      return t("ai.add.rateLimited", { service });
    case "model_unreadable":
      return t("ai.add.unreadable", { service });
    case "list_empty":
      return t(family === "ollama" ? "ai.add.emptyOllama" : "ai.add.empty", { service });
    default:
      return error.message;
  }
}

function Where({ services, loadError, connections, onChoose }: {
  services: Service[] | null;
  loadError: string | null;
  connections: Connections;
  onChoose(event: FlowEvent): void;
}) {
  const t = useT();
  const confirm = useConfirm();
  const [gone, setGone] = useState<Set<string>>(() => new Set());
  const [refused, setRefused] = useState<Record<string, string>>({});
  const shown = services?.filter((s) => !gone.has(s.id)) ?? [];

  async function remove(service: Service) {
    const sure = await confirm(t("ai.add.removeConfirm", { service: service.name }), {
      action: t("ai.add.remove"),
      danger: true,
    });
    if (!sure) return;
    setRefused((before) => {
      const rest = { ...before };
      delete rest[service.id];
      return rest;
    });
    try {
      await connections.services.remove(service.id);
      setGone((before) => new Set(before).add(service.id));
    } catch (error) {
      // An AI added on it from another device meanwhile: the service stays, and says why here.
      setRefused((before) => ({ ...before, [service.id]: describeError(error, t) }));
    }
  }

  const chipButton = (chip: Chip) => (
    <button
      key={chip.label}
      type="button"
      className="btn btn-ghost !px-3 !py-1.5 text-sm"
      onClick={() => onChoose({ type: "chip", chip })}
    >
      {chip.label}
    </button>
  );

  return (
    <div className="flex flex-col gap-5">
      <h3 className="font-display text-lg font-semibold">{t("ai.add.where")}</h3>
      {loadError && <p role="alert" className="text-sm text-blood">{loadError}</p>}
      {shown.length > 0 && (
        <section className="flex flex-col gap-2">
          <h4 className="ui-label">{t("ai.add.savedTitle")}</h4>
          <ul className="flex flex-col gap-2">
            {shown.map((service) => (
              <li key={service.id} className="rounded-xl border border-ink-700">
                <div className="flex items-stretch">
                  <button
                    type="button"
                    className="flex min-h-14 min-w-0 flex-1 items-center gap-3 px-3 py-2.5 text-left"
                    onClick={() => onChoose({
                      type: "service", id: service.id, provider: service.provider, base_url: service.base_url,
                    })}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block font-display text-sm font-medium text-parchment">{service.name}</span>
                      <span className="block text-xs text-mist [overflow-wrap:anywhere]">
                        {service.base_url}
                        {/* The hint carries its own ellipsis. */}
                        {service.api_key_set && ` · ${service.api_key_hint}`}
                      </span>
                      <span className="block text-xs text-mist">
                        {service.model_count > 0
                          ? t("ai.add.saved", { count: service.model_count })
                          : t("ai.add.savedNone")}
                      </span>
                    </span>
                    <ChevronRight className="h-4 w-4 shrink-0 text-mist" />
                  </button>
                  {service.model_count === 0 && (
                    <button type="button" className="btn btn-danger m-2 !px-3 !py-1.5 text-sm" onClick={() => remove(service)}>
                      {t("ai.add.remove")}
                    </button>
                  )}
                </div>
                {refused[service.id] && (
                  <p role="alert" className="border-t border-ink-700 px-3 py-2 text-sm text-blood">{refused[service.id]}</p>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="flex flex-col gap-2">
        <h4 className="ui-label">{t("ai.add.localTitle")}</h4>
        <div className="flex flex-wrap gap-2">{CHIPS.filter((c) => c.local).map(chipButton)}</div>
      </section>
      <section className="flex flex-col gap-2">
        <h4 className="ui-label">{t("ai.add.onlineTitle")}</h4>
        <div className="flex flex-wrap gap-2">{CHIPS.filter((c) => !c.local).map(chipButton)}</div>
      </section>
      <div>
        <button type="button" className="btn btn-ghost !px-3 !py-1.5 text-sm" onClick={() => onChoose({ type: "other" })}>
          {t("ai.add.other")}
        </button>
      </div>
      <p className="text-sm text-mist">{t("ai.add.findsItself")}</p>
    </div>
  );
}

/** Pasting from the page needs a secure context: over plain HTTP on the home network, the phone's
 *  own long press is the way. */
const canPaste = () => window.isSecureContext && typeof navigator.clipboard?.readText === "function";

function KeyField({ value, onChange, placeholder, id }: {
  value: string;
  onChange(value: string): void;
  placeholder: string;
  id: string;
}) {
  const t = useT();
  const [pasteRefused, setPasteRefused] = useState(false);
  const [paste] = useState(canPaste);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex gap-2">
        <input
          {...KEY_FIELD}
          id={id}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
        {paste && (
          <button
            type="button"
            className="btn btn-ghost shrink-0"
            onClick={() => navigator.clipboard.readText().then(
              (text) => {
                setPasteRefused(false);
                onChange(text.trim());
              },
              () => setPasteRefused(true),
            )}
          >
            {t("ai.add.paste")}
          </button>
        )}
      </div>
      {(!paste || pasteRefused) && (
        <p className="text-xs text-mist">{t(pasteRefused ? "ai.add.pasteRefused" : "ai.add.longPress")}</p>
      )}
    </div>
  );
}

function KeyStep({ service, initialKey, onKey, onBack }: {
  service: string;
  initialKey: string;
  onKey(key: string): void;
  onBack(): void;
}) {
  const t = useT();
  const id = useId();
  const [key, setKey] = useState(initialKey);
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        onKey(key);
      }}
    >
      <label htmlFor={id} className="font-display text-lg font-semibold">{t("ai.add.keyTitle", { service })}</label>
      <KeyField id={id} value={key} onChange={setKey} placeholder={t("ai.add.keyPlaceholder")} />
      <p className="text-sm text-mist">{t("ai.add.keyOnce")}</p>
      <div className="mt-2 flex flex-wrap justify-between gap-2">
        <button type="button" className="btn btn-ghost" onClick={onBack}>{t("ai.add.back")}</button>
        <button type="submit" className="btn btn-primary" disabled={!key.trim()}>{t("ai.add.seeModels")}</button>
      </div>
    </form>
  );
}

function AddressStep({ initialAddress, initialKey, onAddress, onBack }: {
  initialAddress: string;
  initialKey: string;
  onAddress(base_url: string, key: string): void;
  onBack(): void;
}) {
  const t = useT();
  const ids = useId();
  const [address, setAddress] = useState(initialAddress);
  const [key, setKey] = useState(initialKey);
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        onAddress(address, key);
      }}
    >
      <h3 className="font-display text-lg font-semibold">{t("ai.add.addressTitle")}</h3>
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
          placeholder="http://192.168.1.20:8080/v1"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
        />
      </label>
      <label className="text-sm text-parchment-dim" htmlFor={`${ids}-key`}>{t("ai.add.addressKeyLabel")}</label>
      <KeyField id={`${ids}-key`} value={key} onChange={setKey} placeholder={t("ai.add.addressKeyPlaceholder")} />
      <div className="mt-2 flex flex-wrap justify-between gap-2">
        <button type="button" className="btn btn-ghost" onClick={onBack}>{t("ai.add.back")}</button>
        <button type="submit" className="btn btn-primary" disabled={!address.trim()}>{t("ai.add.seeModels")}</button>
      </div>
    </form>
  );
}

function Failed({ state, line, onEvent }: { state: FlowState; line: string; onEvent(event: FlowEvent): void }) {
  const t = useT();
  const id = useId();
  // A local chip's address is put right here: the server may listen elsewhere, or on another PC.
  const [address, setAddress] = useState(state.draft?.base_url ?? "");
  const refused = state.error?.kind === "model_auth_refused";
  return (
    <form
      className="flex flex-col items-start gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        onEvent({ type: "retry", ...(state.chip?.local ? { base_url: address } : {}) });
      }}
    >
      <p role="alert" className="text-sm text-blood">{line}</p>
      {state.chip?.local && (
        <label className="flex w-full flex-col gap-1.5 text-sm text-parchment-dim" htmlFor={id}>
          {t("ai.add.addressLabel")}
          <input
            id={id}
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
      )}
      <div className="flex flex-wrap gap-2">
        <button type="submit" className="btn btn-primary">{t("ai.add.retry")}</button>
        {refused && state.serviceId !== null && (
          <button type="button" className="btn btn-ghost" onClick={() => onEvent({ type: "newKey" })}>
            {t("ai.add.changeKey")}
          </button>
        )}
      </div>
      {!refused && (
        <button type="button" className="btn btn-ghost !px-3 !py-1.5 text-sm" onClick={() => onEvent({ type: "byHand" })}>
          {t("ai.add.byHand")}
        </button>
      )}
      <button type="button" className="btn btn-ghost mt-2" onClick={() => onEvent({ type: "back" })}>
        {t("ai.add.back")}
      </button>
    </form>
  );
}

function Pick({ state, name, family, have: already, rereading, failure, onEvent, onReread, onBack, onConfirm }: {
  state: FlowState;
  name: string | null;
  family: Family;
  have: Set<string>;
  rereading: boolean;
  failure: string | null;
  onEvent(event: FlowEvent): void;
  onReread(): void;
  onBack(): void;
  onConfirm(): void;
}) {
  const t = useT();
  const foot = footOf(state);
  const nameOf = (id: string) => state.list?.models.find((m) => m.id === id)?.name ?? id;
  // The price's sentence names the service; another address, its host.
  const shownName = name ?? hostOf(state.draft?.base_url ?? "");
  const label = state.pending
    ? t("ai.add.adding")
    : foot.kind === "tick" ? t("ai.add.tickOne")
      : foot.kind === "saveKey" ? t("ai.add.saveKey")
        : foot.kind === "add" ? t("ai.add.addCount", { count: foot.count })
          : foot.count === 1 ? t("ai.add.addAndAnswer", { name: nameOf(foot.last) })
            : t("ai.add.addHere", { count: foot.count, name: nameOf(foot.last) });

  return (
    <div className="flex flex-col gap-3">
      {state.list && (
        <div>
          <p className="font-display text-lg font-semibold">
            {name ? t("ai.add.answered", { service: name }) : t("ai.add.answeredServer")}
          </p>
          <p className="text-sm text-mist">{t("ai.add.which")}</p>
        </div>
      )}
      {failure && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-blood/40 bg-blood/10 px-3 py-2">
          <p role="alert" className="min-w-0 flex-1 text-sm text-blood">{failure}</p>
          <button type="button" className="btn btn-ghost !px-3 !py-1.5 text-sm" onClick={onReread}>{t("ai.add.retry")}</button>
        </div>
      )}
      {state.keySaved && <p role="status" className="text-sm text-moss">{t("ai.add.keySaved")}</p>}
      {rereading && (
        <p role="status" className="flex items-center gap-2 text-sm text-mist">
          <Loader2 className="h-4 w-4 animate-spin" />
          {name ? t("ai.add.reading", { service: name }) : t("ai.add.readingServer")}
        </p>
      )}
      <ModelPickList
        list={state.list}
        service={{ name: shownName, family }}
        have={already}
        picked={state.picked}
        typed={state.typed}
        answers={state.answers}
        onPick={(id) => onEvent({ type: "pick", id })}
        onUseAsIs={(id) => onEvent({ type: "useAsIs", id })}
        onAnswer={(id, answer) => onEvent({ type: "answer", id, answer })}
        onReread={onReread}
      />
      {/* Stuck at the box's own edge, over its padding: no row shows below it. */}
      <div className="sticky -bottom-4 -mx-4 -mb-4 mt-2 border-t border-ink-700 bg-ink-900 px-4 py-3 sm:-bottom-6 sm:-mx-6 sm:-mb-6 sm:px-6">
        {state.addError && <p role="alert" className="mb-2 text-sm text-blood">{state.addError.message}</p>}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <button type="button" className="btn btn-ghost" onClick={onBack} disabled={state.pending}>{t("ai.add.back")}</button>
          <button
            type="button"
            className="btn btn-primary min-w-0 !whitespace-normal"
            disabled={foot.kind === "tick" || state.pending}
            onClick={onConfirm}
          >
            {label}
          </button>
        </div>
      </div>
    </div>
  );
}

function hostOf(address: string): string {
  try {
    return new URL(address).host || address;
  } catch {
    return address;
  }
}
