import { DataError } from "@/data/errors";
import type { Translate } from "@/i18n/I18nProvider";

/** What is known about a failure: what a `DataError` holds, and just as much of
 *  it as the error event of a reply's stream carries. */
export interface Failure {
  kind?: string | null;
  resource?: string;
  status?: number;
  retryAfter?: number;
  message?: string;
  /** What a model's server said, in its own words, and with its own status. */
  upstream?: string;
  upstreamStatus?: number;
}

/** The sentence for each kind the server names, in `errors.*`. */
const KIND_KEYS: Record<string, string> = {
  locked: "errors.locked",
  wrong_password: "errors.wrongPassword",
  cross_origin: "errors.crossOrigin",
  unknown_host: "errors.unknownHost",
  png_without_card: "errors.pngWithoutCard",
  unrecognized_card_file: "errors.unrecognizedCardFile",
  variant_out_of_range: "errors.variantOutOfRange",
  already_installed: "errors.alreadyInstalled",
  lore_entry_incomplete: "errors.loreEntryIncomplete",
  fact_exists: "errors.factExists",
  file_too_large: "errors.fileTooLarge",
  unsupported_image: "errors.unsupportedImage",
  conversation_empty: "errors.conversationEmpty",
  no_connection: "errors.noConnection",
  // The model's server never answered: not a mistake anyone made, and not
  // Evermind failing to answer, which is "network" below.
  unreachable: "errors.modelUnreachable",
  model_auth_refused: "errors.modelAuthRefused",
  model_not_found: "errors.modelNotFound",
  model_rate_limited: "errors.modelRateLimited",
  model_timeout: "errors.modelTimeout",
  model_unexpected_response: "errors.modelUnexpectedResponse",
  model_unknown_type: "errors.modelUnknownType",
  model_no_text: "errors.modelNoText",
  model_empty: "errors.modelEmpty",
  model_empty_retried: "errors.modelEmptyRetried",
  model_unreadable: "errors.modelUnreadable",
  empty_message: "errors.emptyMessage",
  nothing_to_regenerate: "errors.nothingToRegenerate",
  nothing_to_continue: "errors.nothingToContinue",
  // No answer from Evermind itself.
  network: "errors.unreachable",
};

/** The kinds that stand for a model's server answering badly or not at all.
 *  Its own words, if it said any, are shown after the sentence: Evermind cannot
 *  translate what another program wrote, only frame it. */
const MODEL_SERVER_KINDS = new Set([
  "model_auth_refused",
  "model_not_found",
  "model_rate_limited",
  "model_http_error",
  "model_network_error",
]);

/** What a "not_found" did not find. A resource this version has never heard of
 *  gets the sentence for any missing thing. */
const NOT_FOUND_KEYS: Record<string, string> = {
  character: "errors.notFound.character",
  conversation: "errors.notFound.conversation",
  message: "errors.notFound.message",
  persona: "errors.notFound.persona",
  connection: "errors.notFound.connection",
  lore_entry: "errors.notFound.loreEntry",
  fact: "errors.notFound.fact",
  library_card: "errors.notFound.libraryCard",
};

/** Kinds whose sentence ends with the words the server gave: a model's own
 *  complaint, or whatever broke inside the server. Without any words, the
 *  generic sentence says as much as can be said. */
const KIND_WITH_WORDS: Record<string, string> = {
  model_error: "errors.modelError",
  internal: "errors.internal",
};

/** The sentence for a model's server that answered badly or not at all, and
 *  after it what the server said. */
function modelServerSentence(failure: Failure, t: Translate): string {
  const { kind, upstream, upstreamStatus } = failure;
  const sentence =
    kind === "model_http_error"
      ? t("errors.modelHttpError", { status: upstreamStatus ?? 0 })
      : kind === "model_network_error"
        ? t("errors.modelNetworkError")
        : t(KIND_KEYS[kind as string]);
  return upstream ? `${sentence} ${t("errors.upstream", { text: upstream })}` : sentence;
}

/** The sentence to show for a failure, in the person's language. */
export function describeFailure(failure: Failure, t: Translate): string {
  const { kind, resource, status, message } = failure;
  if (kind && MODEL_SERVER_KINDS.has(kind)) return modelServerSentence(failure, t);
  const known = kind ? KIND_KEYS[kind] : undefined;
  if (known) return t(known);
  if (kind === "not_found") {
    return t((resource && NOT_FOUND_KEYS[resource]) || "errors.notFound.other");
  }
  if (kind === "rate_limited") {
    // The server counts seconds; a minute is what people read.
    const minutes = Math.max(1, Math.ceil((failure.retryAfter ?? 60) / 60));
    return t("errors.rateLimited", { minutes });
  }
  if (kind && KIND_WITH_WORDS[kind]) {
    return message ? t(KIND_WITH_WORDS[kind], { message }) : t("errors.unexpected");
  }
  if (kind === "http_error") return t("errors.server", { status: status ?? 0 });
  // An answer that came without a kind of its own was not written by Evermind
  // for a person: it is FastAPI's own, or a proxy's, and its words are about
  // field names and routes. What it was is in its status.
  if (!kind && status !== undefined) {
    if (status === 422) return t("errors.invalid");
    if (status === 404) return t("errors.notFound.other");
    if (status >= 500) return t("errors.server", { status });
    if (status >= 400) return t("errors.unexpected");
  }
  // A kind this version does not know, or a failure that has no status, has
  // words of the server's to show, which beat a generic sentence.
  return message || t("errors.unexpected");
}

/** The sentence to show for whatever a call to the server threw.
 *
 *  Anything but a `DataError` is a fault in the interface or the browser, in
 *  words that are not meant for a person: `fallback` says what failed, for a
 *  place that has something better than "Something went wrong." */
export function describeError(error: unknown, t: Translate, fallback?: string): string {
  if (error instanceof DataError) return describeFailure(error, t);
  return fallback ?? t("errors.unexpected");
}

/** The sentence to show for the error event that ends a reply's stream. */
export function describeEvent(
  event: {
    message: string;
    kind?: string | null;
    resource?: string;
    upstream?: string;
    upstream_status?: number;
  },
  t: Translate,
): string {
  return describeFailure(
    {
      kind: event.kind,
      resource: event.resource,
      message: event.message,
      upstream: event.upstream,
      upstreamStatus: event.upstream_status,
    },
    t,
  );
}

/** A result the server reports in a 200 body, as the connection test and the
 *  benchmark do: the English sentence in `detail`, and the kind and what the
 *  model's server said next to it. */
export function describeResult(
  result: { detail?: string; kind?: string; upstream?: string; upstream_status?: number },
  t: Translate,
): string {
  return describeFailure(
    {
      kind: result.kind,
      message: result.detail,
      upstream: result.upstream,
      upstreamStatus: result.upstream_status,
    },
    t,
  );
}
