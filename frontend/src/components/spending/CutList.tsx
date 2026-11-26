import type { Cut } from "@/data";
import type { Translate } from "@/i18n/I18nProvider";
import { useI18n } from "@/i18n/I18nProvider";
import { moneyText, pagesOf, servicesOf } from "@/lib/spending";
import type { Kind, Spending, SpendingRest } from "@/types";

/** What the list hands up when a line is opened: its cut, its key ("" for the drafts of cards not
 *  saved yet), the name it shows, and whether the price of an AI is to be typed at once. */
export type Opened = { cut: Cut; key: string; name: string; price?: boolean };

/** The name of a character's line: the drafts of cards not saved yet have none of their own, and
 *  a deleted one whose name was forgotten is said so. */
export function cardName(id: string | null, name: string | null, deleted: boolean, t: Translate): string {
  if (id === null) return t("spending.newCard");
  if (name === null) return deleted ? t("spending.deletedCard") : "";
  return name;
}

/** The name of a conversation's line: its title, else its character's name. */
export function conversationName(title: string | null, card: string | null, deleted: boolean, t: Translate): string {
  if (title) return title;
  if (deleted) return t("spending.deletedConversation");
  return card ?? "";
}

/** "deleted", and "Scenario" for a scenario: what a name alone does not say. */
export function tagsOf(deleted: boolean, named: boolean, kind: Kind | null, t: Translate): string[] {
  const tags: string[] = [];
  if (kind === "scenario") tags.push(t("chat.panel.kindScenario"));
  if (deleted && named) tags.push(t("spending.deleted"));
  return tags;
}

/** The lines of one cut of a period, the dearest first. Each opens its detail; none is a call. */
export function CutList({ summary, cut, onOpen }: { summary: Spending; cut: Cut; onOpen(line: Opened): void }) {
  const { t, locale } = useI18n();
  const money = (cost: number, unpriced: number) => moneyText({ cost, unpriced, currency: summary.currency }, "line", locale, t);
  const calls = (count: number) => t("spending.calls", { count });

  if (cut === "model") {
    const groups = servicesOf(summary.models);
    const dearest = Math.max(0, ...summary.models.map((m) => m[3] + m[4]));
    return (
      <div data-cut-list className="flex flex-col gap-5">
        {groups.map((group) => (
          <section key={group.name ?? ""} data-service className="flex flex-col gap-1">
            <h3 className="flex flex-wrap items-baseline justify-between gap-x-3 px-3 text-sm">
              <span className="ui-label min-w-0 [overflow-wrap:anywhere]">{group.name}</span>
              <span className="text-parchment-dim">{money(group.cost, group.unpriced)}</span>
            </h3>
            {group.upstream.map((by) => (
              <p key={by.name} className="px-3 text-xs text-mist">
                {t("spending.upstream", { money: money(by.cost, 0), name: by.name })}
              </p>
            ))}
            <ul className="flex flex-col gap-1">
              {group.lines.map(([id, name, , cost, upstream, , count, , tokensIn, tokensOut, unpriced, deleted]) => {
                const noPrice = cost + upstream === 0 && unpriced > 0;
                return (
                  <Line
                    key={id ?? name ?? ""}
                    lineKey={id ?? ""}
                    name={name ?? ""}
                    tags={tagsOf(deleted, true, null, t)}
                    amount={money(cost + upstream, unpriced)}
                    share={dearest ? (cost + upstream) / dearest : 0}
                    small={[calls(count), noPrice && t("spending.tokens", { read: tokensIn, written: tokensOut })]}
                    onOpen={id === null ? undefined : () => onOpen({ cut, key: id, name: name ?? "" })}
                    after={noPrice && id !== null && !deleted && (
                      <button
                        type="button"
                        className="btn btn-ghost ml-3 max-w-full whitespace-normal !py-1 text-sm"
                        onClick={() => onOpen({ cut, key: id, name: name ?? "", price: true })}
                      >
                        {t("spending.setPrice")}
                      </button>
                    )}
                  />
                );
              })}
            </ul>
          </section>
        ))}
        {summary.free.length > 0 && (
          <section data-free className="flex flex-col gap-1">
            <h3 className="ui-label px-3">{t("spending.free.title")}</h3>
            <ul className="flex flex-col gap-1">
              {summary.free.map(([id, name, where, replies, tokensIn, service]) => (
                <li key={id ?? name ?? ""} className="px-3 py-2 text-sm">
                  <span className="block text-parchment [overflow-wrap:anywhere]">{name}</span>
                  <span className="block text-xs text-mist">
                    {[
                      where === "service" ? t("spending.free.service", { service: service ?? "" }) : t(`spending.free.${where}`),
                      t("spending.free.replies", { count: replies }),
                      t("spending.free.pages", { count: pagesOf(tokensIn) }),
                    ].join(" · ")}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    );
  }

  if (cut === "use") {
    const dearest = Math.max(0, ...summary.uses.map((u) => u[1]));
    return (
      <ul data-cut-list className="flex flex-col gap-1">
        {summary.uses.map(([use, cost, count, retried, unpriced, , , free]) => (
          <Line
            key={use}
            lineKey={use}
            name={t(`spending.use.${use}`)}
            amount={free === count ? t("ai.free") : money(cost, unpriced)}
            share={dearest ? cost / dearest : 0}
            small={[
              calls(count),
              use === "reply" && retried > 0 && t("spending.retried", { count: retried }),
              free > 0 && free < count && t("spending.freeCalls", { count: free }),
            ]}
            onOpen={() => onOpen({ cut, key: use, name: t(`spending.use.${use}`) })}
          />
        ))}
      </ul>
    );
  }

  // Characters and conversations: those only with free AIs after the rest, the rest in one line.
  const rows = cut === "card"
    ? summary.cards.map(([id, name, kind, cost, count, unpriced, freeOnly, deleted]) => ({
      key: id ?? "", name: cardName(id, name, deleted, t), tags: tagsOf(deleted, id !== null && name !== null, kind, t),
      cost, count, unpriced, freeOnly, small: undefined as string | undefined,
    }))
    : summary.conversations.map(([id, title, card, cost, count, unpriced, freeOnly, deleted]) => ({
      key: id, name: conversationName(title, card, deleted, t), tags: tagsOf(deleted, !!title, null, t),
      cost, count, unpriced, freeOnly, small: title ? card ?? undefined : undefined,
    }));
  const rest: SpendingRest | null = cut === "card" ? summary.cards_rest : summary.conversations_rest;
  const dearest = Math.max(0, ...rows.map((r) => r.cost));
  const line = (r: (typeof rows)[number]) => (
    <Line
      key={r.key}
      lineKey={r.key}
      name={r.name}
      tags={r.tags}
      amount={r.freeOnly ? t("ai.free") : money(r.cost, r.unpriced)}
      share={dearest ? r.cost / dearest : 0}
      small={[r.small, calls(r.count)]}
      onOpen={() => onOpen({ cut, key: r.key, name: r.name })}
    />
  );
  const free = rows.filter((r) => r.freeOnly);
  return (
    <ul data-cut-list className="flex flex-col gap-1">
      {rows.filter((r) => !r.freeOnly).map(line)}
      {free.length > 0 && <li className="ui-label mt-3 px-3">{t("spending.free.only")}</li>}
      {free.map(line)}
      {rest && (
        <li className="flex flex-wrap items-baseline justify-between gap-x-3 px-3 py-2 text-sm text-mist">
          <span>{t("spending.rest", { count: rest[0] })}</span>
          <span>{money(rest[1], rest[3])}</span>
        </li>
      )}
    </ul>
  );
}

/** One line: a button of 56 px at least, its name, its amount, a thin bar as long as its share of
 *  the dearest, and in small what it holds. `after`: a button of its own beside it. */
function Line({ lineKey, name, tags = [], amount, share, small, onOpen, after }: {
  lineKey: string;
  name: string;
  tags?: string[];
  amount: string;
  share: number;
  small: (string | false | undefined)[];
  onOpen?: () => void;
  after?: React.ReactNode;
}) {
  const said = small.filter(Boolean).join(" · ");
  const body = (
    <>
      <span className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span className="min-w-0 text-parchment [overflow-wrap:anywhere]">
          {name}
          {tags.map((tag) => <span key={tag} className="ml-2 text-xs text-mist">{tag}</span>)}
        </span>
        <span className="text-sm text-parchment-dim">{amount}</span>
      </span>
      <span aria-hidden className="block h-1 w-full rounded-full bg-ink-800">
        <span className="block h-1 rounded-full bg-ember-600" style={{ width: `${Math.round(share * 100)}%` }} />
      </span>
      {said && <span className="text-xs text-mist">{said}</span>}
    </>
  );
  const box = "flex min-h-14 w-full flex-col justify-center gap-1 rounded-lg px-3 py-2 text-left";
  return (
    <li data-key={lineKey}>
      {onOpen
        ? <button type="button" className={`${box} hover:bg-ink-800`} onClick={onOpen}>{body}</button>
        : <div className={box}>{body}</div>}
      {after}
    </li>
  );
}
