import { LoadFailure } from "@/components/ui/LoadFailure";
import { Sheet, SheetWait } from "@/components/ui/Sheet";
import { data, DataError, type AiSaved, type Cut, type ModelUpdate, type SpendingQuery } from "@/data";
import { useI18n } from "@/i18n/I18nProvider";
import { describeError } from "@/lib/errors";
import { amountText, duringText, measuredText, moneyText, type Period } from "@/lib/spending";
import { isolated } from "@/lib/utils";
import { PriceFields } from "@/components/ai/PriceFields";
import type {
  Ai, SpendingDetail, SpendingDetailOfCard, SpendingDetailOfConversation, SpendingDetailOfModel, SpendingDetailOfUse,
  SpendingModelLine, SpendingSources,
} from "@/types";
import { X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { cardName, conversationName, type Opened } from "./CutList";

/** How long "Saved." stays under the price saved, as on an AI's page. */
const SAVED_MS = 2000;
const SOURCES: (keyof SpendingSources)[] = ["reported", "computed_read", "computed_typed", "estimated"];

/** One line of Spending opened: what it holds, read from the server for the period shown. A sheet
 *  on a phone; beside the list on a wide screen (`beside`). */
export function LineDetail({ line, range, per, since, currency, beside, reread, onClose, onRepriced, onForgot }: {
  line: Opened;
  range: SpendingQuery;
  per: Period;
  since: string;
  currency: string;
  beside: boolean;
  /** Changes when the page has read the period again: the line is read again with it. */
  reread: number;
  onClose(): void;
  /** A price typed here filled earlier calls: the page reads everything again. */
  onRepriced(): void;
  onForgot(cut: "card" | "conversation", key: string): void;
}) {
  const { t, locale } = useI18n();
  const spending = data.spending!;
  const [detail, setDetail] = useState<SpendingDetail | null>(null);
  const [failure, setFailure] = useState<{ error: unknown } | null>(null);
  const [pricing, setPricing] = useState(!!line.price);
  const [repriced, setRepriced] = useState(0);
  const [forgetting, setForgetting] = useState(false);
  const [forgetError, setForgetError] = useState<string | null>(null);
  const { from, to } = range;
  // Beside the list, the line opened is where the focus goes, as a sheet takes it: said by its title.
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (beside) heading.current?.focus({ preventScroll: true });
  }, [beside]);

  // What is shown stays until the next answer: a price being typed is not taken away by a read.
  const asked = useRef(0);
  const load = useCallback(() => {
    const mine = ++asked.current;
    spending.detail({ from, to, cut: line.cut, key: line.key }).then(
      (found) => mine === asked.current && (setDetail(found), setFailure(null)),
      (error) => mine === asked.current && setFailure({ error }),
    );
  }, [spending, from, to, line.cut, line.key]);
  useEffect(() => {
    load();
  }, [load, reread]);

  // A line that no longer exists is named by its cut: nothing more of it will be read.
  const gone = !detail && failure !== null && failure.error instanceof DataError && failure.error.kind === "not_found";
  const name = detail ? nameOf(line.cut, line.key, detail, t)
    : gone ? t(`spending.cut.${line.cut}`) : line.name || t("common.loading");
  const during = duringText(per, since, locale, t);
  const money = (cost: number, unpriced = 0) => moneyText({ cost, unpriced, currency }, "line", locale, t);
  // A name someone typed is isolated in its sentence; the name of a use or a source is the page's.
  const share = (label: string, said: string, key: string, typed = true) => (
    <li key={key} className="[overflow-wrap:anywhere]">{t("spending.detail.share", { name: typed ? isolated(label) : label, money: said })}</li>
  );
  const models = (lines: SpendingModelLine[]) => (
    <Part title={t("spending.detail.models")}>
      {lines.map(([id, label, cost, , unpriced, free]) =>
        share(label ?? "", free ? t("ai.free") : money(cost, unpriced), id ?? label ?? ""))}
    </Part>
  );
  const uses = (lines: [string, number, number, number, number][]) => (
    <Part title={t("spending.cut.use")}>
      {lines.map(([use, cost, , , unpriced]) => share(t(`spending.use.${use}`), money(cost, unpriced), use, false))}
    </Part>
  );

  async function forget() {
    if (line.cut !== "card" && line.cut !== "conversation") return;
    setForgetting(true);
    setForgetError(null);
    try {
      await spending.forget(line.cut, line.key);
      setDetail((before) => before && ("title" in before ? { ...before, title: null } : { ...before, name: null }));
      onForgot(line.cut, line.key);
    } catch (error) {
      setForgetError(describeError(error, t));
    }
    setForgetting(false);
  }

  let body: React.ReactNode;
  if (failure && !detail) body = <LoadFailure error={failure.error} onRetry={gone ? undefined : load} />;
  else if (!detail) body = <SheetWait />;
  else {
    const cost = "cost_upstream" in detail ? detail.cost + detail.cost_upstream : detail.cost;
    const named = "title" in detail ? detail.title !== null : "kind" in detail && detail.name !== null;
    body = (
      <div className="flex flex-col gap-4 text-sm text-parchment-dim">
        <p>
          <span className="font-display text-2xl font-semibold text-parchment">
            {moneyText({ cost, unpriced: detail.unpriced_calls, currency }, "total", locale, t)}
          </span>
          <span className="ml-2 text-mist">{t("spending.calls", { count: detail.calls })}</span>
        </p>
        {line.cut === "model" && <OfModel
          detail={detail as SpendingDetailOfModel}
          money={money}
          share={share}
          uses={uses}
          pricing={pricing}
          onPrice={() => setPricing(true)}
          modelId={line.key}
          repriced={repriced}
          onRepriced={(count) => {
            setRepriced(count);
            onRepriced();
          }}
        />}
        {line.cut === "card" && (
          <>
            {models((detail as SpendingDetailOfCard).models)}
            <Part title={t("spending.detail.conversations")}>
              {(detail as SpendingDetailOfCard).conversations.map(([id, title, c, , unpriced, freeOnly, deleted]) =>
                share(conversationName(title, null, deleted, t), freeOnly ? t("ai.free") : money(c, unpriced), id))}
              {(() => {
                const rest = (detail as SpendingDetailOfCard).conversations_rest;
                return rest && share(t("spending.rest", { count: rest[0] }), money(rest[1], rest[3]), "rest", false);
              })()}
            </Part>
          </>
        )}
        {line.cut === "conversation" && (() => {
          const convo = detail as SpendingDetailOfConversation;
          return (
            <>
              {models(convo.models)}
              {uses(convo.uses)}
              {convo.growth && (
                <div className="flex flex-col gap-1">
                  <p>{t("spending.detail.growth", {
                    first: amountText(convo.growth.first, currency, locale, t),
                    last: amountText(convo.growth.last, currency, locale, t),
                  })}</p>
                  <p className="text-xs text-mist">{t("spending.detail.growthWhy")}</p>
                </div>
              )}
            </>
          );
        })()}
        {line.cut === "use" && models((detail as SpendingDetailOfUse).models)}
        {line.cut !== "model" && line.cut !== "use" && line.key !== "" && (detail as SpendingDetailOfCard).deleted && named && (
          <div className="flex flex-col items-start gap-1">
            <button type="button" className="btn btn-ghost max-w-full whitespace-normal !py-1.5 text-sm" disabled={forgetting} onClick={forget}>
              {t("spending.forget")}
            </button>
            {forgetError && <p role="alert" className="text-sm text-blood">{forgetError}</p>}
          </div>
        )}
      </div>
    );
  }

  if (!beside) {
    return (
      <Sheet title={name} named hint={during} onClose={onClose}>
        <div data-line-detail>{body}</div>
      </Sheet>
    );
  }
  return (
    <aside data-line-detail aria-label={name} className="panel sticky top-4 flex flex-col gap-3 self-start px-5 py-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 ref={heading} tabIndex={-1} className="font-display text-lg font-semibold break-words hyphens-auto outline-none"><bdi>{name}</bdi></h2>
          <p className="mt-0.5 text-xs text-mist">{during}</p>
        </div>
        <button type="button" onClick={onClose} aria-label={t("common.close")} className="-mr-2 shrink-0 rounded-lg p-1.5 text-mist hover:bg-ink-700 hover:text-parchment pointer-coarse:p-3">
          <X className="h-5 w-5" />
        </button>
      </div>
      {body}
    </aside>
  );
}

/** The name a line opened shows, as the list names it. */
function nameOf(cut: Cut, key: string, detail: SpendingDetail, t: ReturnType<typeof useI18n>["t"]): string {
  if (cut === "use") return t(`spending.use.${(detail as SpendingDetailOfUse).use}`);
  if (cut === "conversation") {
    const convo = detail as SpendingDetailOfConversation;
    return conversationName(convo.title, convo.card_name, convo.deleted, t);
  }
  if (cut === "card") {
    const card = detail as SpendingDetailOfCard;
    return cardName(key === "" ? null : key, card.name, card.deleted, t);
  }
  return (detail as SpendingDetailOfModel).name ?? "";
}

function Part({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1">
      <h3 className="ui-label">{title}</h3>
      <ul className="flex flex-col gap-0.5">{children}</ul>
    </section>
  );
}

/** Where an amount comes from: a line for each share that is not zero, and nothing at all when none
 *  is. `atMost`: a computed amount read from the cache with no price for it, said so, and why.
 *  `children`: lines of its own after (what a service billed through a key of one's own is in a
 *  share too). */
export function Sources({ sources, money, atMost = false, children }: {
  sources: SpendingSources;
  money(cost: number): string;
  atMost?: boolean;
  children?: React.ReactNode;
}) {
  const { t } = useI18n();
  const shares = SOURCES.filter((source) => sources[source] > 0);
  if (shares.length === 0) return null;
  return (
    <section className="flex flex-col gap-1">
      <h3 className="ui-label">{t("spending.detail.sources")}</h3>
      <ul className="flex flex-col gap-0.5">
        {shares.map((source) => {
          const said = money(sources[source]);
          const most = atMost && (source === "computed_read" || source === "computed_typed");
          return (
            <li key={source} className="[overflow-wrap:anywhere]">
              {t("spending.detail.share", { name: t(`spending.source.${source}`), money: most ? t("spending.money.atMost", { money: said }) : said })}
            </li>
          );
        })}
        {children}
      </ul>
      {atMost && <p className="text-xs text-mist">{t("spending.detail.atMostWhy")}</p>}
    </section>
  );
}

function OfModel({ detail, money, share, uses, pricing, onPrice, modelId, repriced, onRepriced }: {
  detail: SpendingDetailOfModel;
  money(cost: number, unpriced?: number): string;
  share(label: string, said: string, key: string, typed?: boolean): React.ReactNode;
  uses(lines: [string, number, number, number, number][]): React.ReactNode;
  pricing: boolean;
  onPrice(): void;
  modelId: string;
  repriced: number;
  onRepriced(count: number): void;
}) {
  const { t, locale } = useI18n();
  const { tokens, sources } = detail;
  return (
    <>
      {detail.per100 && <p>{measuredText(detail.per100, locale, t)}</p>}
      <section className="flex flex-col gap-1">
        <h3 className="ui-label">{t("spending.detail.read")}</h3>
        <p>{t("spending.detail.in", { count: tokens.in })}</p>
        {tokens.cached > 0 && <p className="text-xs text-mist">{t("spending.detail.cached", { count: tokens.cached })}</p>}
        <p>{t("spending.detail.out", { count: tokens.out })}</p>
        {tokens.reasoning > 0 && <p className="text-xs text-mist">{t("spending.detail.reasoning", { count: tokens.reasoning })}</p>}
      </section>
      <Sources sources={sources} money={money} atMost={detail.at_most}>
        {detail.cost_upstream > 0 && detail.upstream && (
          <li>{t("spending.upstream", { money: money(detail.cost_upstream), name: isolated(detail.upstream) })}</li>
        )}
      </Sources>
      {uses(detail.uses)}
      <Part title={t("spending.detail.cards")}>
        {detail.cards.map(([id, name, , cost, , deleted]) => share(cardName(id, name, deleted, t), money(cost), id ?? ""))}
        {detail.cards_rest && share(t("spending.rest", { count: detail.cards_rest[0] }), money(detail.cards_rest[1], detail.cards_rest[3]), "rest", false)}
      </Part>
      {(detail.priceable || pricing) && (pricing
        ? <PriceEditor modelId={modelId} onRepriced={onRepriced} />
        : (
          <button type="button" className="btn btn-ghost self-start max-w-full whitespace-normal !py-1.5 text-sm pointer-coarse:min-h-11" onClick={onPrice}>
            {t("spending.setPrice")}
          </button>
        ))}
      {repriced > 0 && <p role="status" className="text-sm text-moss">{t("spending.repriced", { count: repriced })}</p>}
    </>
  );
}

/** The price of an AI typed in place, as on its own page; read from the list of AIs when asked. */
function PriceEditor({ modelId, onRepriced }: { modelId: string; onRepriced(count: number): void }) {
  const { t } = useI18n();
  const models = data.connections?.models;
  // Undefined until the list is read; null when the AI is no longer in it.
  const [ai, setAi] = useState<Ai | null | undefined>(undefined);
  const [failure, setFailure] = useState<{ error: unknown } | null>(null);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const read = useCallback(() => {
    models?.list().then((listed) => {
      setAi(listed.find((each) => each.id === modelId) ?? null);
      setFailure(null);
    }, (error) => setFailure({ error }));
  }, [models, modelId]);
  useEffect(read, [read]);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  // One save at a time, in the order typed, as on an AI's page.
  const saves = useRef<Promise<void>>(Promise.resolve());
  function save(_at: string, change: ModelUpdate): Promise<void> {
    const next = saves.current.then(async () => {
      setSaveError(null);
      try {
        const answer: AiSaved = await models!.update(modelId, change);
        setAi(answer);
        setSaved(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setSaved(false), SAVED_MS);
        if (answer.repriced) onRepriced(answer.repriced);
      } catch (error) {
        setSaveError(error instanceof DataError && error.kind === "not_found" ? t("ai.page.gone") : describeError(error, t));
      }
    });
    saves.current = next;
    return next;
  }

  if (failure) return <LoadFailure error={failure.error} onRetry={read} />;
  if (ai === undefined) return models ? <SheetWait /> : null;
  if (ai === null) return <p className="text-sm text-mist">{t("ai.page.gone")}</p>;
  return (
    <PriceFields
      ai={ai}
      t={t}
      hint={t("ai.list.priceHint", { service: ai.service.name })}
      onSave={save}
      said={() => (
        <>
          {saved && <span role="status" className="text-xs text-moss animate-fade">{t("ai.page.saved")}</span>}
          {saveError && <p role="alert" className="text-sm text-blood">{saveError}</p>}
        </>
      )}
    />
  );
}
