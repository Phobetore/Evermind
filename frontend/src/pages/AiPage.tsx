import { AiLine } from "@/components/ai/AiLine";
import { LOCAL_FAMILIES } from "@/components/ai/addFlow";
import { MigrationNotice } from "@/components/ai/MigrationNotice";
import { ServiceForm } from "@/components/ai/ServiceForm";
import { useConfirm } from "@/components/ui/Confirm";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { data, DataError, type AiSaved, type ModelUpdate } from "@/data";
import type { Translate } from "@/i18n/I18nProvider";
import { useI18n } from "@/i18n/I18nProvider";
import { pages, successorOf, warningsOf } from "@/lib/ai";
import { describeError, describeFailure } from "@/lib/errors";
import { timeAgo } from "@/lib/utils";
import type { Ai, Service } from "@/types";
import { clsx } from "clsx";
import { ArrowLeft, ChevronRight, Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router";

/** How long a number typed waits for the next key before it is saved: long enough not to save
 *  every figure of "16384" on its way, short enough to be saved before the page is left. */
const TYPING_MS = 700;
/** How long "Saved." stays beside the control that was saved. */
const SAVED_MS = 2000;
/** The engine's floor (engine.py): a reading capacity under it is refused by the server. */
const LEAST_CONTEXT = 512;

/** The route /settings/ai/:id. Reads the list of AIs, and the one shown again from its server on
 *  opening (through the server's ten-minute list). */
export function AiPage() {
  const { id = "" } = useParams();
  // Only an edition that keeps its own models has AIs.
  if (!data.connections) return <Navigate to="/settings" replace />;
  // Another AI is another page: nothing typed or said of the one before is kept.
  return <AiView key={id} id={id} />;
}

type ReadError = { kind: string; message: string };

function AiView({ id }: { id: string }) {
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const connections = data.connections as NonNullable<typeof data.connections>;
  const [ais, setAis] = useState<Ai[] | null>(null);
  const [loadFailure, setLoadFailure] = useState<{ error: unknown } | null>(null);
  const [readFailure, setReadFailure] = useState<ReadError | null>(null);
  const [reading, setReading] = useState(false);
  const [bench, setBench] = useState<{ ok: boolean; text: string } | null>(null);
  const [benching, setBenching] = useState(false);
  const [editingService, setEditingService] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<{ at: string; message: string } | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const grouped = new Intl.NumberFormat(locale);

  const replace = useCallback((model: Ai) => {
    setAis((before) => before && before.map((ai) => {
      if (ai.id === model.id) return model;
      // One default at a time: the server took the mark from the others.
      return model.is_default && ai.is_default ? { ...ai, is_default: false } : ai;
    }));
  }, []);

  const gone = useCallback(() => setAis((before) => before && before.filter((ai) => ai.id !== id)), [id]);

  const read = useCallback((fresh: boolean) => {
    setReading(true);
    connections.models.refresh(id, { fresh }).then(
      (answer) => {
        replace(answer.model);
        setReadFailure(answer.read_ok ? null : answer.error);
      },
      (error) => {
        if (error instanceof DataError && error.kind === "not_found") gone();
        else setReadFailure({ kind: error instanceof DataError ? error.kind ?? "" : "", message: describeError(error, t) });
      },
    ).finally(() => setReading(false));
  }, [connections, id, replace, gone, t]);

  const load = useCallback(() => {
    connections.models.list().then(
      (listed) => {
        setAis(listed);
        setLoadFailure(null);
        if (listed.some((ai) => ai.id === id)) read(false);
      },
      (error) => setLoadFailure({ error }),
    );
  }, [connections, id, read]);

  // Once, on opening: a later change of language must not read the server again.
  const loaded = useRef(false);
  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    load();
  }, [load]);

  useEffect(() => () => {
    if (savedTimer.current) clearTimeout(savedTimer.current);
  }, []);

  async function save(at: string, change: ModelUpdate) {
    setSaveError(null);
    try {
      const saved: AiSaved = await connections.models.update(id, change);
      replace(saved);
      setSavedAt(at);
      if (savedTimer.current) clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setSavedAt(null), SAVED_MS);
    } catch (error) {
      if (error instanceof DataError && error.kind === "not_found") gone();
      else setSaveError({ at, message: describeError(error, t) });
    }
  }

  const ai = ais?.find((each) => each.id === id) ?? null;

  if (loadFailure) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-10">
        <LoadFailure error={loadFailure.error} onRetry={load} />
      </div>
    );
  }
  if (ais === null) {
    return <div className="mx-auto max-w-3xl px-6 py-10 text-mist animate-pulse-soft">{t("common.loading")}</div>;
  }
  if (ai === null) {
    return (
      <div className="mx-auto flex max-w-3xl flex-col items-start gap-4 px-6 py-10">
        <p className="font-display text-xl font-semibold">{t("ai.page.gone")}</p>
        <Link to="/settings" className="btn btn-ghost">{t("ai.add.backToSettings")}</Link>
      </div>
    );
  }

  const others = ais.filter((each) => each.id !== id);
  const said = (at: string) => (
    <>
      {savedAt === at && <span role="status" className="text-xs text-moss animate-fade">{t("ai.page.saved")}</span>}
      {saveError?.at === at && <p role="alert" className="text-sm text-blood">{saveError.message}</p>}
    </>
  );
  const online = !ai.service.local;
  const priceAsked = !ai.price.varies && (ai.service.local || ai.price.read_in === null || ai.price.read_out === null);

  async function benchmark() {
    setBenching(true);
    setBench(null);
    try {
      const result = await connections.models.benchmark(id);
      setBench({
        ok: true,
        text: t("ai.benchmarkResult", {
          tokensPerSecond: result.tokens_per_s ?? 0,
          firstTokenSeconds: result.first_token_seconds ?? 0,
        }),
      });
    } catch (error) {
      setBench({ ok: false, text: describeError(error, t, t("ai.page.benchmarkFailed")) });
    }
    setBenching(false);
  }

  async function remove(current: Ai) {
    const after = successorOf(current, ais ?? []);
    const count = current.conversation_count;
    const last = !others.some((other) => other.service.id === current.service.id);
    const sure = await confirm(t("ai.page.removeConfirm", { name: current.name }), {
      action: t("ai.page.removeAction"),
      danger: true,
      details: (count > 0 || (last && current.service.api_key_set)) && (
        <>
          {count > 0 && (
            <p>
              {after
                ? t("ai.page.removeMoves", { count, name: after.name })
                : t("ai.page.removeOrphans", { count })}
            </p>
          )}
          {last && current.service.api_key_set && <p>{t("ai.page.removeKey", { service: current.service.name })}</p>}
        </>
      ),
    });
    if (!sure) return;
    setRemoving(true);
    setRemoveError(null);
    try {
      await connections.models.remove(current.id);
      navigate("/settings");
    } catch (error) {
      if (error instanceof DataError && error.kind === "not_found") {
        navigate("/settings");
        return;
      }
      // Said here, the box closed, as everywhere else: the AI is still there, and the button with it.
      setRemoveError(describeError(error, t));
      setRemoving(false);
    }
  }

  function serviceSaved(service: Service) {
    setAis((before) => before && before.map((each) => each.service.id !== service.id ? each : {
      ...each,
      service: {
        ...each.service, name: service.name, family: service.family, local: service.local, loopback: service.loopback,
        provider: service.provider, base_url: service.base_url, api_key_set: service.api_key_set, api_key_hint: service.api_key_hint,
      },
    }));
  }

  const onService = ais.filter((each) => each.service.id === ai.service.id).length;

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <Link to="/settings" className="touch-target mb-4 inline-flex items-center gap-1.5 text-sm text-mist hover:text-parchment">
        <ArrowLeft className="h-4 w-4" />
        {t("nav.settings")}
      </Link>
      <header className="mb-6 animate-rise">
        <h1 className="font-display text-3xl font-semibold [overflow-wrap:anywhere]">{ai.name}</h1>
        <div className="mt-2">
          <AiLine ai={ai} />
        </div>
      </header>

      {others.length > 0 && (
        <nav aria-label={t("ai.page.others")} className="mb-6 flex flex-wrap gap-2">
          {others.map((other) => (
            <Link
              key={other.id}
              to={`/settings/ai/${other.id}`}
              className="btn btn-ghost !px-3 !py-1.5 max-w-full text-sm"
            >
              <span className="truncate">{other.name}</span>
            </Link>
          ))}
        </nav>
      )}

      <MigrationNotice ais={[ai]} onChanged={replace} own />

      <ServerRead
        ai={ai}
        t={t}
        reading={reading}
        failure={readFailure}
        onReread={() => read(true)}
        bench={bench}
        benching={benching}
        onBenchmark={benchmark}
      />

      {priceAsked && online && (
        <section className="mb-6">
          <PriceFields ai={ai} t={t} hint={t("ai.list.priceHint", { service: ai.service.name })} onSave={save} said={said} />
        </section>
      )}

      <section className="mb-6 flex flex-col gap-5">
        <div className="flex flex-col gap-1.5">
          <TextField
            label={t("ai.page.name")}
            value={ai.name}
            onSave={(name) => name && save("name", { name })}
          />
          {said("name")}
        </div>
        <DefaultSwitch ai={ai} t={t} onSave={() => save("default", { is_default: true })} />
        {said("default")}
      </section>

      <details className="group mb-8 rounded-xl border border-ink-700">
        <summary className="ui-label flex min-h-11 cursor-pointer list-none items-center gap-1.5 px-4 [&::-webkit-details-marker]:hidden">
          <ChevronRight className="h-4 w-4 shrink-0 transition-transform group-open:rotate-90" aria-hidden="true" />
          {t("ai.page.advanced")}
        </summary>
        <div className="flex flex-col gap-6 border-t border-ink-700 px-4 py-4">
          <ContextControl ai={ai} t={t} grouped={grouped} onSave={save} said={said} />
          <CeilingControl ai={ai} t={t} grouped={grouped} onSave={save} said={said} />
          <Sampling ai={ai} t={t} onSave={save} said={said} />
          <div className="flex flex-col gap-1.5">
            <TextField
              label={t("ai.page.modelId")}
              value={ai.model}
              mono
              onSave={(model) => model && save("model", { model })}
            />
            {said("model")}
          </div>
          {priceAsked && !online && (
            <PriceFields ai={ai} t={t} hint={t("ai.page.priceLocalHint")} onSave={save} said={said} />
          )}
          <div className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-ink-700 px-3 py-3 text-sm text-mist">
            <div className="min-w-0 [overflow-wrap:anywhere]">
              <p className="font-semibold text-parchment-dim">{t("ai.page.service", { name: ai.service.name })}</p>
              <p>
                {ai.service.base_url} ·{" "}
                {ai.service.api_key_set ? t("ai.page.key", { hint: ai.service.api_key_hint }) : t("ai.page.noKey")}
              </p>
              <p>
                {t("ai.page.apiType", {
                  type: t(ai.service.provider === "anthropic" ? "ai.page.apiAnthropic" : "ai.page.apiOpenai"),
                })}
              </p>
            </div>
            <button type="button" className="btn btn-ghost !py-1.5 text-sm" onClick={() => setEditingService(true)}>
              {t("ai.page.edit")}
            </button>
          </div>
        </div>
      </details>
      {editingService && (
        <ServiceForm
          service={ai.service}
          count={onService}
          onSaved={serviceSaved}
          onClose={() => setEditingService(false)}
        />
      )}

      <div className="flex flex-col items-start gap-2">
        <button type="button" className="btn btn-danger" disabled={removing} onClick={() => remove(ai)}>
          {removing && <Loader2 className="h-4 w-4 animate-spin" />}
          {t("ai.page.remove")}
        </button>
        {removeError && <p role="alert" className="text-sm text-blood">{removeError}</p>}
      </div>
    </div>
  );
}

/** What the server said of the AI the last time it was read, and the buttons that ask it again. */
function ServerRead({ ai, t, reading, failure, onReread, bench, benching, onBenchmark }: {
  ai: Ai;
  t: Translate;
  reading: boolean;
  failure: ReadError | null;
  onReread(): void;
  bench: { ok: boolean; text: string } | null;
  benching: boolean;
  onBenchmark(): void;
}) {
  const { context, reply_cap: cap } = ai;
  const loadedHere = context.read_kind === "served" && ai.service.local;
  const reads = context.read === null
    ? t("ai.page.readsUntold")
    : t(loadedHere ? "ai.page.readsLoaded" : "ai.page.readsValue", { tokens: context.read, count: pages(context.read) });
  const reply = ai.output_read === null ? t("ai.page.replyNoMax") : t("ai.page.replyUpTo", { tokens: ai.output_read });
  const thinking = ai.reasons === true
    ? cap.mode === "auto" ? t("ai.page.thinksAuto")
      : cap.mode === "unsent" ? t("ai.page.thinksUnsent")
        : t("ai.page.thinksFixed", { tokens: cap.tokens ?? 0 })
    : ai.reasons === false ? t("ai.page.writesDirectly") : t("ai.page.thinkingUnknown");
  const { read_in: input, read_out: output } = ai.price;
  const price = ai.free
    ? t(ai.service.loopback ? "ai.page.freeHere" : ai.service.local ? "ai.page.freeNetwork" : "ai.page.free")
    : ai.price.varies ? t("ai.page.priceVaries")
      : input !== null && output !== null ? t("ai.page.priceKnown", { input, output })
        : t("ai.page.priceNone", { service: ai.service.name });
  const failureLine = failure && (
    failure.kind === "model_auth_refused" ? t("ai.page.keyRefused", { service: ai.service.name })
      : failure.kind === "unreachable" || failure.kind === "list_timeout" ? t("ai.page.noAnswer", { service: ai.service.name })
        : describeFailure({ kind: failure.kind, message: failure.message }, t)
  );

  return (
    <section className="panel mb-6 px-5 py-4">
      <p className="ui-label mb-3">
        {ai.limits_read_at ? t("ai.page.readAt", { age: timeAgo(ai.limits_read_at, t) }) : t("ai.page.notRead")}
      </p>
      {failureLine && (
        <p role="alert" className="mb-3 text-sm text-blood">
          {failureLine} {t("ai.page.previousRead")}
        </p>
      )}
      <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
        <dt className="text-mist">{t("ai.page.reads")}</dt>
        <dd className="text-parchment-dim">{reads}</dd>
        <dt className="text-mist">{t("ai.page.reply")}</dt>
        <dd className="text-parchment-dim">{reply}</dd>
        <dt className="text-mist">{t("ai.page.thinking")}</dt>
        <dd className="text-parchment-dim">{thinking}</dd>
        <dt className="text-mist">{t("ai.page.price")}</dt>
        <dd className="text-parchment-dim">{price}</dd>
      </dl>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button type="button" className="btn btn-ghost !py-1.5 text-sm" onClick={onReread} disabled={reading}>
          {reading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          {t("ai.page.reread")}
        </button>
        <button type="button" className="btn btn-ghost !py-1.5 text-sm" onClick={onBenchmark} disabled={benching}>
          {benching && <Loader2 className="h-4 w-4 animate-spin" />}
          {t("ai.page.benchmark")}
        </button>
        {/* There before it has anything to say, as a screen reader only hears a change. */}
        <span role="status" className={clsx("text-sm", bench?.ok ? "text-moss" : "text-blood")}>{bench?.text}</span>
      </div>
    </section>
  );
}

type Save = (at: string, change: ModelUpdate) => Promise<void>;
type Said = (at: string) => React.ReactNode;

/** A whole number of tokens as typed, spaces and separators of thousands allowed; "" is none, and
 *  anything else is not a number at all. */
function tokensOf(text: string): number | null | undefined {
  const plain = text.replace(/[\s.,'  ]/g, "");
  if (plain === "") return null;
  return /^\d+$/.test(plain) ? Number(plain) : undefined;
}

/** A decimal typed with a comma or a point; "" is none, and anything else is not a number at all. */
function decimalOf(text: string): number | null | undefined {
  const plain = text.trim().replace(",", ".");
  if (plain === "") return null;
  const value = Number(plain);
  return Number.isFinite(value) ? value : undefined;
}

/** A figure saved as it is typed: once the keys stop for a moment, and when the field is left. A
 *  value under `least` waits for the field to be left, being most likely on its way to a larger one;
 *  so does an emptied one there, most likely cleared to type another: saved, it would let go of
 *  the figure (a capacity back to its server, the field closed under the person's keys). */
function FigureField({ id, value, parse, onSave, least, labelledBy, placeholder, inputMode = "decimal" }: {
  id?: string;
  value: number | null;
  parse(text: string): number | null | undefined;
  onSave(value: number | null): void;
  least?: number;
  labelledBy?: string;
  placeholder?: string;
  inputMode?: "decimal" | "numeric";
}) {
  const field = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(value === null ? "" : String(value));
  const sent = useRef(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A value changed elsewhere (a notice's button) shows, unless the person is typing in it.
  useEffect(() => {
    sent.current = value;
    if (document.activeElement !== field.current) setText(value === null ? "" : String(value));
  }, [value]);

  function commit(typed: string, leaving: boolean) {
    const parsed = parse(typed);
    if (parsed === undefined || parsed === sent.current) return;
    if (!leaving && least !== undefined && (parsed === null || parsed < least)) return;
    sent.current = parsed;
    onSave(parsed);
  }

  // Gone from the page with a figure typed and not saved (the browser's back, which is Android's
  // back button, leaves no field): saved as leaving the field saves it. Nothing changed, nothing sent.
  const latest = useRef({ text, commit });
  useEffect(() => {
    latest.current = { text, commit };
  });
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
    latest.current.commit(latest.current.text, true);
  }, []);

  return (
    <input
      ref={field}
      id={id}
      className="field"
      type="text"
      inputMode={inputMode}
      autoComplete="off"
      aria-labelledby={labelledBy}
      placeholder={placeholder}
      value={text}
      onChange={(e) => {
        const typed = e.target.value;
        setText(typed);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => commit(typed, false), TYPING_MS);
      }}
      onBlur={(e) => {
        if (timer.current) clearTimeout(timer.current);
        commit(e.target.value, true);
      }}
    />
  );
}

/** A text saved when the field is left, or on Enter. An empty one goes back to what is saved. */
function TextField({ label, value, onSave, mono = false }: {
  label: string;
  value: string;
  onSave(value: string): void;
  mono?: boolean;
}) {
  const id = useId();
  const [text, setText] = useState(value);
  // What was saved, changed (by this field's own save, or elsewhere), is what the field shows.
  const [saved, setSaved] = useState(value);
  if (saved !== value) {
    setSaved(value);
    setText(value);
  }
  // Gone from the page with a text typed and not saved: saved as leaving the field saves it.
  // What was last sent, so that a text sent as the field was left is not sent a second time.
  const sent = useRef(value);
  const latest = useRef({ text, value, onSave });
  useEffect(() => {
    latest.current = { text, value, onSave };
  });
  useEffect(() => () => {
    const { text: typed, value: before, onSave: save } = latest.current;
    const kept = typed.trim();
    if (kept && kept !== before && kept !== sent.current) save(kept);
  }, []);
  return (
    <label className="flex flex-col gap-1.5" htmlFor={id}>
      <span className="ui-label">{label}</span>
      <input
        id={id}
        className={clsx("field", mono && "font-mono")}
        autoComplete="off"
        spellCheck={!mono}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        onBlur={() => {
          const typed = text.trim();
          if (!typed) setText(value);
          else if (typed !== value) {
            sent.current = typed;
            onSave(typed);
          }
        }}
      />
    </label>
  );
}

function DefaultSwitch({ ai, t, onSave }: { ai: Ai; t: Translate; onSave(): void }) {
  const ids = useId();
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <span id={`${ids}-label`} className="block text-sm text-parchment-dim">{t("ai.page.default")}</span>
        <span id={`${ids}-hint`} className="mt-0.5 block text-xs text-mist">{t("ai.page.defaultHint")}</span>
      </div>
      {/* Only ever turned on: another becomes the default by being marked, never none. */}
      <button
        type="button"
        role="switch"
        aria-checked={ai.is_default}
        aria-labelledby={`${ids}-label`}
        aria-describedby={`${ids}-hint`}
        disabled={ai.is_default}
        onClick={onSave}
        className="touch-target relative mt-0.5 h-6 w-11 shrink-0 rounded-full disabled:cursor-default"
      >
        <span
          aria-hidden
          className={clsx(
            "absolute inset-0 rounded-full border transition-colors",
            ai.is_default ? "border-ember-500 bg-ember-600" : "border-ink-600 bg-ink-800",
          )}
        />
        <span
          aria-hidden
          className={clsx(
            "absolute top-1 left-1 h-4 w-4 rounded-full bg-parchment transition-transform",
            ai.is_default && "translate-x-5",
          )}
        />
      </button>
    </div>
  );
}

/** Two or three choices side by side, the one in force pressed, with its figure under its name. */
function Choice({ pressed, onClick, children, small }: {
  pressed: boolean;
  onClick(): void;
  children: React.ReactNode;
  small?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={(e) => {
        // Focused first, as Chrome does and Safari does not: a figure being typed is left, and
        // saved, before the choice that may take its field away.
        e.currentTarget.focus();
        onClick();
      }}
      className={clsx(
        // No min-w-0: a narrow screen takes a choice's words to the next line, never one cut mid-word.
        "flex min-h-11 flex-1 flex-col items-center justify-center rounded-lg border px-2 py-1.5 text-center text-sm",
        pressed ? "border-ember-500 bg-ember-glow text-parchment" : "border-ink-600 text-mist hover:text-parchment",
      )}
    >
      <span className="break-words">{children}</span>
      {small && <small className="text-xs text-mist">{small}</small>}
    </button>
  );
}

function Warning({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-ember-300">{children}</p>;
}

function ContextControl({ ai, t, grouped, onSave, said }: {
  ai: Ai; t: Translate; grouped: Intl.NumberFormat; onSave: Save; said: Said;
}) {
  const ids = useId();
  const { own, read, read_kind: kind, used, source } = ai.context;
  const [ownMode, setOwnMode] = useState(own !== null);
  // A value saved elsewhere (a notice's button) presses the choice it is: never "My value" left empty.
  const [savedOwn, setSavedOwn] = useState(own);
  if (savedOwn !== own) {
    setSavedOwn(own);
    setOwnMode(own !== null);
  }
  // A server that loads a size of its own and has not said which.
  const untoldServer = LOCAL_FAMILIES.has(ai.service.family) && !(kind === "served" || kind === "configured" || kind === "observed");
  const warned = warningsOf(ai).includes("above_read_window");
  return (
    <div role="group" aria-labelledby={`${ids}-label`} className="flex flex-col gap-2">
      <span id={`${ids}-label`} className="ui-label">{t("ai.page.context")}</span>
      <div className="flex gap-2">
        <Choice
          pressed={!ownMode}
          small={read === null ? t("ai.page.untold") : grouped.format(read)}
          onClick={() => {
            setOwnMode(false);
            if (own !== null) void onSave("context", { context_own: null });
          }}
        >
          {t("ai.page.followServer")}
        </Choice>
        <Choice pressed={ownMode} small={own === null ? t("ai.page.toType") : grouped.format(own)} onClick={() => setOwnMode(true)}>
          {t("ai.page.ownValue")}
        </Choice>
      </div>
      {ownMode && (
        <FigureField
          value={own}
          parse={tokensOf}
          least={LEAST_CONTEXT}
          inputMode="numeric"
          labelledBy={`${ids}-label`}
          onSave={(value) => void onSave("context", { context_own: value })}
        />
      )}
      {said("context")}
      <p className="text-xs leading-relaxed text-mist">{t("ai.page.contextHint")}</p>
      {source === "size_untold" && <p className="text-xs text-mist">{t("ai.page.sizeUntold", { tokens: used })}</p>}
      {source === "own" && untoldServer && <p className="text-xs text-mist">{t("ai.page.sizeUntoldOwn")}</p>}
      {source === "assumed" && <p className="text-xs text-mist">{t("ai.page.assumed", { tokens: used })}</p>}
      {warned && read !== null && (
        <Warning>{t("ai.page.aboveReadWindow", { service: ai.service.name, tokens: read })}</Warning>
      )}
    </div>
  );
}

function CeilingControl({ ai, t, grouped, onSave, said }: {
  ai: Ai; t: Translate; grouped: Intl.NumberFormat; onSave: Save; said: Said;
}) {
  const ids = useId();
  const { mode, tokens } = ai.reply_cap;
  const [shown, setShown] = useState(mode);
  // The same for a ceiling saved elsewhere: the choice pressed is the one in force.
  const [savedMode, setSavedMode] = useState(mode);
  if (savedMode !== mode) {
    setSavedMode(mode);
    setShown(mode);
  }
  const warnings = warningsOf(ai);
  const choose = (next: "auto" | "unsent") => {
    setShown(next);
    if (mode !== next) void onSave("cap", { reply_cap: { mode: next } });
  };
  return (
    <div role="group" aria-labelledby={`${ids}-label`} className="flex flex-col gap-2">
      <span id={`${ids}-label`} className="ui-label">{t("ai.page.cap")}</span>
      <div className="flex gap-2">
        <Choice pressed={shown === "auto"} onClick={() => choose("auto")}>{t("ai.page.capAuto")}</Choice>
        <Choice pressed={shown === "unsent"} onClick={() => choose("unsent")}>{t("ai.page.capUnsent")}</Choice>
        <Choice
          pressed={shown === "fixed"}
          small={tokens === null ? t("ai.page.toType") : grouped.format(tokens)}
          onClick={() => {
            setShown("fixed");
            // Its figure from before, if it had one: back as it was.
            if (mode !== "fixed" && tokens !== null) void onSave("cap", { reply_cap: { mode: "fixed", tokens } });
          }}
        >
          {t("ai.page.ownValue")}
        </Choice>
      </div>
      {shown === "fixed" && (
        <FigureField
          value={tokens}
          parse={tokensOf}
          least={1}
          inputMode="numeric"
          labelledBy={`${ids}-label`}
          onSave={(value) => value !== null && void onSave("cap", { reply_cap: { mode: "fixed", tokens: value } })}
        />
      )}
      {said("cap")}
      <p className="text-xs leading-relaxed text-mist">
        {t(ai.service.family === "openai" ? "ai.page.capHintAutoOpenai" : "ai.page.capHintAuto")}{" "}
        {t("ai.page.capHintUnsent")}
      </p>
      {mode === "fixed" && warnings.includes("above_read_output") && ai.output_read !== null && (
        <Warning>{t("ai.page.aboveReadOutput", { service: ai.service.name, tokens: ai.output_read })}</Warning>
      )}
      {mode === "fixed" && warnings.includes("cap_above_window") && (
        <Warning>{t("ai.page.capAboveWindow", { tokens: ai.context.used })}</Warning>
      )}
    </div>
  );
}

function Sampling({ ai, t, onSave, said }: { ai: Ai; t: Translate; onSave: Save; said: Said }) {
  const ids = useId();
  const field = (key: "temperature" | "top_p" | "frequency_penalty" | "presence_penalty", label: string) => (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label className="ui-label" htmlFor={`${ids}-${key}`}>{label}</label>
      <FigureField
        id={`${ids}-${key}`}
        value={ai[key]}
        parse={decimalOf}
        placeholder={t("ai.page.modelDefault")}
        onSave={(value) => void onSave(key, { [key]: value })}
      />
      {said(key)}
    </div>
  );
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 min-[360px]:grid-cols-2">
        {field("temperature", t("ai.page.temperature"))}
        {field("top_p", t("ai.page.topP"))}
      </div>
      <p className="text-xs leading-relaxed text-mist">{t("ai.page.samplingHint")}</p>
      {/* Anthropic is never sent them (providers/anthropic.py). */}
      {ai.service.provider !== "anthropic" && (
        <>
          <div className="grid grid-cols-1 gap-3 min-[360px]:grid-cols-2">
            {field("frequency_penalty", t("ai.page.frequency"))}
            {field("presence_penalty", t("ai.page.presence"))}
          </div>
          <p className="text-xs leading-relaxed text-mist">{t("ai.page.penaltyHint")}</p>
        </>
      )}
    </div>
  );
}

/** Its price, typed, when the server gives none: per million tokens read and written. A negative
 *  one is sent as typed, for the server's refusal to be said under the fields rather than the
 *  figure dropped in silence. */
function PriceFields({ ai, t, hint, onSave, said }: { ai: Ai; t: Translate; hint: string; onSave: Save; said: Said }) {
  const ids = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-sm text-parchment-dim">{t("ai.list.priceTitle")}</p>
      <div className="flex gap-3">
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-mist" htmlFor={`${ids}-in`}>
          {t("ai.list.priceIn")}
          <FigureField
            parse={decimalOf}
            id={`${ids}-in`}
            value={ai.price.own_in}
            onSave={(value) => void onSave("price", { price_own_in: value })}
          />
        </label>
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-mist" htmlFor={`${ids}-out`}>
          {t("ai.list.priceOut")}
          <FigureField
            parse={decimalOf}
            id={`${ids}-out`}
            value={ai.price.own_out}
            onSave={(value) => void onSave("price", { price_own_out: value })}
          />
        </label>
      </div>
      {said("price")}
      <p className="text-xs text-mist">{hint}</p>
    </div>
  );
}
