import { DataError } from "@/data/errors";
import type { Translate } from "@/i18n/I18nProvider";

/** What is known about a failure: what a `DataError` holds, or how a reply failed. */
export interface Failure {
  kind?: string | null;
  resource?: string;
  status?: number;
  retryAfter?: number;
  message?: string;
}

/** The sentence for each kind the server names, in `errors.*`. One with `{message}` in it quotes
 *  the server's words: Evermind cannot translate what a model's server wrote, only frame it. */
const KIND_KEYS: Record<string, string> = {
  locked: "errors.locked",
  wrong_password: "errors.wrongPassword",
  too_large: "errors.tooLarge",
  cross_origin: "errors.crossOrigin",
  unknown_host: "errors.unknownHost",
  png_without_card: "errors.pngWithoutCard",
  unrecognized_card_file: "errors.unrecognizedCardFile",
  variant_out_of_range: "errors.variantOutOfRange",
  fact_exists: "errors.factExists",
  fact_empty: "errors.factEmpty",
  memory_busy: "errors.memoryBusy",
  facts_changed: "errors.factsChanged",
  conversation_changed: "errors.conversationChanged",
  too_few_facts: "errors.tooFewFacts",
  file_too_large: "errors.fileTooLarge",
  unsupported_image: "errors.unsupportedImage",
  conversation_empty: "errors.conversationEmpty",
  no_connection: "errors.noConnection",
  // The model's server never answered, at the address the message holds.
  unreachable: "errors.modelUnreachable",
  model_connection_lost: "errors.modelNetworkError",
  model_auth_refused: "errors.modelAuthRefused",
  model_not_found: "errors.modelNotFound",
  model_rate_limited: "errors.modelRateLimited",
  model_error: "errors.modelError",
  model_no_text: "errors.modelNoText",
  model_empty: "errors.modelEmpty",
  model_unreadable: "errors.modelUnreadable",
  empty_message: "errors.emptyMessage",
  nothing_to_regenerate: "errors.nothingToRegenerate",
  nothing_to_continue: "errors.nothingToContinue",
  turn_running: "errors.turnRunning",
  internal: "errors.internal",
  // No answer from Evermind itself.
  network: "errors.unreachable",
  offline: "errors.offline",
  // The page's own: a message that got no answer, and that the server, answering since, does not have.
  not_sent: "errors.notSent",
};

/** What a "not_found" did not find. A resource this version has never heard of
 *  gets the sentence for any missing thing. */
const NOT_FOUND_KEYS: Record<string, string> = {
  character: "errors.notFound.character",
  conversation: "errors.notFound.conversation",
  message: "errors.notFound.message",
  persona: "errors.notFound.persona",
  connection: "errors.notFound.connection",
  fact: "errors.notFound.fact",
};

/** The sentence to show for a failure, in the person's language. */
export function describeFailure(failure: Failure, t: Translate): string {
  const { kind, resource, status, message } = failure;
  const known = kind ? KIND_KEYS[kind] : undefined;
  if (known) return t(known, { message: message ?? "" });
  if (kind === "not_found") {
    return t((resource && NOT_FOUND_KEYS[resource]) || "errors.notFound.other");
  }
  if (kind === "rate_limited") {
    // The server counts seconds; a minute is what people read.
    const minutes = Math.max(1, Math.ceil((failure.retryAfter ?? 60) / 60));
    return t("errors.rateLimited", { minutes });
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

/** No answer came, which says nothing of whether what was asked for arrived. */
export const isUnanswered = (error: unknown) =>
  error instanceof DataError && (error.kind === "network" || error.kind === "offline");

/** The sentence to show for whatever a call to the server threw.
 *
 *  Anything but a `DataError` is a fault in the interface or the browser, in
 *  words that are not meant for a person: `fallback` says what failed, for a
 *  place that has something better than "Something went wrong." */
export function describeError(error: unknown, t: Translate, fallback?: string): string {
  if (error instanceof DataError) return describeFailure(error, t);
  return fallback ?? t("errors.unexpected");
}
