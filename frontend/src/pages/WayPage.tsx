import { useConfirm } from "@/components/ui/Confirm";
import { FigureField, decimalOf, tokensOf } from "@/components/ui/FigureField";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { TextField } from "@/components/ui/TextField";
import { ReadingCard } from "@/components/ways/ReadingCard";
import { WayChoices, type WayChange, type WayChoice } from "@/components/ways/WayChoices";
import { data, DataError } from "@/data";
import { BUILT_IN, LEVELS, REPLY_ROOM } from "@/engine";
import { useI18n } from "@/i18n/I18nProvider";
import { describeError } from "@/lib/errors";
import { wayName } from "@/lib/ways";
import type { Ai, WayFields, WayListed, Ways } from "@/types";
import { clsx } from "clsx";
import { ArrowLeft, ChevronRight, Loader2 } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";

/** How long "Saved." stays beside what was saved. */
const SAVED_MS = 2000;
/** The page's side gutters: layout, not text, so in pixels at most (as on an AI's page). */
const GUTTER = "px-[min(1.5rem,24px)]";
/** The fold's own gutters, capped the same way: in rem, the largest text would leave its words one to a line. */
const FOLD_GUTTER = "px-[min(1rem,16px)]";

type Change = Partial<WayFields> & { name?: string };

/** The route /settings/way/:id. Reads the ways, and the AIs where the edition has its own, for the
 *  card of what the AI reads. */
export function WayPage() {
  const { id = "" } = useParams();
  // Another way is another page: nothing typed or said of the one before is kept.
  return <WayView key={id} id={id} />;
}

function WayView({ id }: { id: string }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const [ways, setWays] = useState<Ways | null>(null);
  const [ais, setAis] = useState<Ai[] | null>(null);
  const [loadFailure, setLoadFailure] = useState<{ error: unknown } | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<{ at: string; message: string } | null>(null);
  // The write a button is waiting for, of the copy, the default, the removal or the original values.
  const [acting, setActing] = useState<string | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(() => {
    Promise.all([
      data.ways.list().then(setWays),
      data.connections?.models.list().then(setAis),
    ]).then(() => setLoadFailure(null), (error) => setLoadFailure({ error }));
  }, []);

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

  /** What the server holds now, after a write it refused: the page shows nothing it does not keep. */
  const reread = useCallback(() => data.ways.list().then(setWays, () => {}), []);

  const replace = useCallback((saved: WayListed) => {
    setWays((before) => before && { ...before, ways: before.ways.map((way) => (way.id === saved.id ? saved : way)) });
  }, []);

  function flash(at: string) {
    setSavedAt(at);
    if (savedTimer.current) clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setSavedAt(null), SAVED_MS);
  }

  // One save at a time, in the order they were made, as on an AI's page: on a slow link two sent
  // side by side could reach the server in the other order, and the one made first be the one kept.
  const saves = useRef<Promise<void>>(Promise.resolve());
  function save(at: string, change: Change): Promise<void> {
    // Shown at once: on a slow link the choice pressed must not wait for the answer to look pressed.
    setWays((before) => before && {
      ...before,
      ways: before.ways.map((way) => (way.id === id ? { ...way, ...change } : way)),
    });
    const next = saves.current.then(() => send(at, change));
    saves.current = next;
    return next;
  }

  async function send(at: string, change: Change) {
    setSaveError(null);
    try {
      replace(await data.ways.update(id, change));
      flash(at);
    } catch (error) {
      setSaveError({ at, message: describeError(error, t) });
      await reread();
    }
  }

  /** A write other than a figure's: its button waits for it, and a failure is said under them. */
  async function act(at: string, work: () => Promise<void>) {
    setActing(at);
    setSaveError(null);
    try {
      await work();
    } catch (error) {
      setSaveError({ at, message: describeError(error, t) });
      if (error instanceof DataError && error.kind === "not_found") await reread();
    }
    setActing(null);
  }

  const said = (at: string) => (
    <>
      {savedAt === at && <span role="status" className="text-xs text-moss animate-fade">{t("ways.saved")}</span>}
      {saveError?.at === at && <p role="alert" className="text-sm text-blood">{saveError.message}</p>}
    </>
  );

  if (loadFailure) {
    return (
      <div className={clsx("mx-auto max-w-3xl py-10", GUTTER)}>
        <LoadFailure error={loadFailure.error} onRetry={load} />
      </div>
    );
  }
  if (ways === null || (data.connections && ais === null)) {
    return <div className={clsx("mx-auto max-w-3xl py-10 text-mist animate-pulse-soft", GUTTER)}>{t("common.loading")}</div>;
  }
  const way = ways.ways.find((each) => each.id === id);
  if (!way) {
    return (
      <div className={clsx("mx-auto flex max-w-3xl flex-col items-start gap-4 py-10", GUTTER)}>
        <p className="font-display text-xl font-semibold">{t("errors.notFound.way")}</p>
        <Link to="/settings" className="btn btn-ghost max-w-full whitespace-normal">{t("ai.add.backToSettings")}</Link>
      </div>
    );
  }

  const name = wayName(way, t);
  const offered = ways.default === id;

  function choose(change: WayChange) {
    if (change.history_limit !== undefined) void save("history", { history_limit: change.history_limit });
    // A length keeps the room it needs, as a conversation's own choice does.
    if (change.reply_length) void save("length", { reply_length: change.reply_length, reply_room: REPLY_ROOM[change.reply_length] });
    if (change.reminders) void save("reminders", { ...LEVELS[change.reminders] });
  }

  async function copy() {
    await act("copy", async () => {
      const made = await data.ways.copy(id, t("ways.copyName", { name }));
      navigate(`/settings/way/${encodeURIComponent(made.id)}`);
    });
  }

  async function remove(current: WayListed) {
    // Counted again: another device may have started a conversation in it since the page opened.
    const fresh = await data.ways.list().catch(() => null);
    if (fresh) setWays(fresh);
    const listed = fresh ?? ways;
    const count = listed?.ways.find((each) => each.id === current.id)?.conversations ?? current.conversations;
    // Its conversations go to the way offered, or to Balanced when it is the one offered.
    const toId = listed && listed.default !== current.id ? listed.default : "balanced";
    const to = listed?.ways.find((each) => each.id === toId) ?? { id: toId, name: null };
    const sure = await confirm(
      count === 0 ? t("ways.removeConfirmNone") : t("ways.removeConfirm", { count, name: wayName(to, t) }),
      { action: t("ways.remove"), danger: true },
    );
    if (!sure) return;
    await act("remove", async () => {
      await data.ways.remove(current.id);
      navigate("/settings");
    });
  }

  return (
    <div className={clsx("mx-auto max-w-3xl py-10", GUTTER)}>
      <Link to="/settings" className="touch-target mb-4 inline-flex items-center gap-1.5 text-sm text-mist hover:text-parchment">
        <ArrowLeft className="h-4 w-4" />
        {t("nav.settings")}
      </Link>
      <header className="mb-6 animate-rise">
        {way.built_in ? (
          <h1 className="font-display text-3xl font-semibold [overflow-wrap:anywhere]">{name}</h1>
        ) : (
          <>
            <h1 className="sr-only">{name}</h1>
            <div className="flex flex-col gap-1.5">
              <TextField label={t("ways.nameLabel")} value={name} onSave={(typed) => typed && save("name", { name: typed })} />
              {said("name")}
            </div>
          </>
        )}
        <p className="mt-3 text-sm leading-relaxed text-parchment-dim">
          {way.conversations === 0
            ? t("ways.usageNone")
            : t("ways.usage", { count: way.conversations })}
        </p>
      </header>

      <section className="mb-6">
        <WayChoices fields={way} onChange={choose} said={(choice: WayChoice) => said(choice)} />
      </section>

      <div className="mb-6">
        <ReadingCard
          way={way}
          light={id === "light" ? null : ways.ways.find((each) => each.id === "light") ?? (BUILT_IN.light as WayFields)}
          ais={ais}
          hostWindow={null}
        />
      </div>

      <details className="group mb-8 rounded-xl border border-ink-700">
        <summary className={clsx("ui-label flex min-h-11 cursor-pointer list-none items-center gap-1.5 [&::-webkit-details-marker]:hidden", FOLD_GUTTER)}>
          <ChevronRight className="h-4 w-4 shrink-0 transition-transform group-open:rotate-90" aria-hidden="true" />
          {t("ways.advanced")}
        </summary>
        <div className={clsx("flex flex-col gap-6 border-t border-ink-700 py-[min(1rem,16px)]", FOLD_GUTTER)}>
          <ExactValues way={way} passages={ways.passages_available} save={save} said={said} />
        </div>
      </details>

      <div className="flex flex-col items-start gap-3">
        <div className="flex flex-wrap gap-3">
          {way.built_in && way.overridden && (
            <button
              type="button"
              className="btn btn-ghost max-w-full whitespace-normal !py-1.5 text-sm"
              disabled={acting !== null}
              onClick={() => act("actions", async () => replace(await data.ways.reset(id)))}
            >
              {t("ways.reset")}
            </button>
          )}
          <button type="button" className="btn btn-ghost max-w-full whitespace-normal !py-1.5 text-sm" disabled={acting !== null} onClick={copy}>
            {t("ways.copy")}
          </button>
        </div>
        {said("copy")}
        {said("actions")}
        {offered ? (
          <p className="text-sm text-moss">{t("ways.isDefault")}</p>
        ) : (
          <button
            type="button"
            className="btn btn-ghost max-w-full whitespace-normal !py-1.5 text-sm"
            disabled={acting !== null}
            onClick={() => act("default", async () => setWays(await data.ways.setDefault(id)))}
          >
            {t("ways.makeDefault", { name })}
          </button>
        )}
        {said("default")}
        {!way.built_in && (
          <button type="button" className="btn btn-danger mt-4 max-w-full whitespace-normal" disabled={acting !== null} onClick={() => remove(way)}>
            {acting === "remove" && <Loader2 className="h-4 w-4 animate-spin" />}
            {t("ways.remove")}
          </button>
        )}
        {said("remove")}
      </div>
    </div>
  );
}

type Save = (at: string, change: Change) => Promise<void>;
type Said = (at: string) => React.ReactNode;

/** A share as the person types it, in per cent: 0.06 is 6. Rounded, as 0.07 × 100 is not 7. */
const percentOf = (share: number | null) => (share === null ? null : Math.round(share * 10_000) / 100);

/** The way's figures, each saved as it is typed. Floors only: the server says what it refuses. */
function ExactValues({ way, passages, save, said }: { way: WayListed; passages: boolean; save: Save; said: Said }) {
  const { t } = useI18n();
  const ids = useId();
  const figure = (at: string, label: string, value: number | null, onSave: (value: number | null) => void, hint?: string, required = false) => (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label className="ui-label break-words" htmlFor={`${ids}-${at}`}>{label}</label>
      <FigureField id={`${ids}-${at}`} value={value} parse={tokensOf} inputMode="numeric" onSave={onSave} required={required} />
      {hint && <p className="text-xs leading-relaxed text-mist">{hint}</p>}
      {said(at)}
    </div>
  );
  /** A cap and a share of the same reminder: a number typed in one clears the other. */
  const pair = (at: string, label: string, cap: "lore_cap" | "passage_cap", share: "lore_share" | "passage_share", hint?: string) => (
    <div role="group" aria-labelledby={`${ids}-${at}-cap-label`} className="flex flex-col gap-3">
      <div className="flex min-w-0 flex-col gap-1.5">
        <label id={`${ids}-${at}-cap-label`} className="ui-label break-words" htmlFor={`${ids}-${at}-cap`}>{label}</label>
        <FigureField
          id={`${ids}-${at}-cap`}
          value={way[cap]}
          parse={tokensOf}
          inputMode="numeric"
          onSave={(value) => void save(at, value === null ? { [cap]: null } : { [cap]: value, [share]: null })}
        />
      </div>
      <div className="flex min-w-0 flex-col gap-1.5">
        <label className="ui-label break-words" htmlFor={`${ids}-${at}-share`}>{t("ways.exact.share")}</label>
        <FigureField
          id={`${ids}-${at}-share`}
          value={percentOf(way[share])}
          parse={decimalOf}
          onSave={(value) => void save(at, value === null ? { [share]: null } : { [share]: value / 100, [cap]: null })}
        />
      </div>
      {hint && <p className="text-xs leading-relaxed text-mist">{hint}</p>}
      <p className="text-xs text-mist">{t("ways.exact.noLimit")}</p>
      {said(at)}
    </div>
  );
  return (
    <>
      {/* None is no figure for it: the field emptied saves nothing and shows the figure kept, 0 rereads all. */}
      {figure("exact-history", t("ways.exact.history"), way.history_limit, (value) => value !== null && void save("exact-history", { history_limit: value }), undefined, true)}
      {figure("exact-room", t("ways.exact.room"), way.reply_room, (value) => void save("exact-room", { reply_room: value }), t("ways.exact.roomHint"))}
      <div className="flex flex-col gap-3">
        {figure("facts-cap", t("ways.exact.factsCap"), way.facts_cap, (value) => void save("facts-cap", { facts_cap: value }))}
        {figure("max-facts", t("ways.exact.maxFacts"), way.max_facts, (value) => void save("max-facts", { max_facts: value }), t("ways.exact.noLimit"))}
      </div>
      {pair("lore", t("ways.exact.loreCap"), "lore_cap", "lore_share")}
      {passages ? (
        pair("passages", t("ways.exact.passages"), "passage_cap", "passage_share", t("ways.exact.passagesHint"))
      ) : (
        <div className="flex flex-col gap-1.5">
          <span className="ui-label">{t("ways.exact.passages")}</span>
          <p className="text-sm text-mist">{t("ways.unavailable")}</p>
        </div>
      )}
    </>
  );
}
