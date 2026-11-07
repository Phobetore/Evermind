import { describe, expect, test } from "vitest";
import { DataError } from "@/data/errors";
import en from "@/i18n/locales/en.json";
import { describeError, describeEvent, describeFailure, describeResult } from "./errors";

/** A translator that shows which key and which values it was asked for, so that
 *  a test says what the person would be told without depending on the wording. */
const t = (key: string, vars?: Record<string, string | number>) =>
  vars ? `${key} ${JSON.stringify(vars)}` : key;

describe("an error the server named", () => {
  test.each([
    ["locked", "errors.locked"],
    ["wrong_password", "errors.wrongPassword"],
    ["too_large", "errors.tooLarge"],
    ["cross_origin", "errors.crossOrigin"],
    ["unknown_host", "errors.unknownHost"],
    ["png_without_card", "errors.pngWithoutCard"],
    ["unrecognized_card_file", "errors.unrecognizedCardFile"],
    ["variant_out_of_range", "errors.variantOutOfRange"],
    ["already_installed", "errors.alreadyInstalled"],
    ["lore_entry_incomplete", "errors.loreEntryIncomplete"],
    ["fact_exists", "errors.factExists"],
    ["fact_empty", "errors.factEmpty"],
    ["memory_busy", "errors.memoryBusy"],
    ["facts_changed", "errors.factsChanged"],
    ["conversation_changed", "errors.conversationChanged"],
    ["too_few_facts", "errors.tooFewFacts"],
    ["file_too_large", "errors.fileTooLarge"],
    ["unsupported_image", "errors.unsupportedImage"],
    ["conversation_empty", "errors.conversationEmpty"],
    ["no_connection", "errors.noConnection"],
    ["model_timeout", "errors.modelTimeout"],
    ["model_unexpected_response", "errors.modelUnexpectedResponse"],
    ["model_unknown_type", "errors.modelUnknownType"],
    ["model_no_text", "errors.modelNoText"],
    ["model_empty", "errors.modelEmpty"],
    ["model_empty_retried", "errors.modelEmptyRetried"],
    ["model_unreadable", "errors.modelUnreadable"],
    ["empty_message", "errors.emptyMessage"],
    ["nothing_to_regenerate", "errors.nothingToRegenerate"],
    ["nothing_to_continue", "errors.nothingToContinue"],
  ])("%s is said as %s", (kind, key) => {
    expect(describeError(new DataError("English words", { kind, status: 400 }), t)).toBe(key);
  });

  test.each([
    ["model_auth_refused", "errors.modelAuthRefused"],
    ["model_not_found", "errors.modelNotFound"],
    ["model_rate_limited", "errors.modelRateLimited"],
  ])("%s is %s, followed by what the model's server said if it said anything", (kind, key) => {
    const bare = new DataError("English words", { kind, status: 502 });
    expect(describeError(bare, t)).toBe(key);
    const said = new DataError("English words", { kind, status: 502, upstream: "Incorrect key." });
    expect(describeError(said, t)).toBe(`${key} errors.upstream {"text":"Incorrect key."}`);
  });

  test("a model's server that cannot be reached is named by the address that was tried", () => {
    const error = new DataError("words", {
      kind: "unreachable", status: 502, upstreamUrl: "http://localhost:1234/v1",
    });
    expect(describeError(error, t)).toBe('errors.modelUnreachable {"url":"http://localhost:1234/v1"}');
  });

  test("and, without an address to name, by the sentence that does not need one", () => {
    expect(describeError(new DataError("words", { kind: "unreachable", status: 502 }), t)).toBe(
      "errors.modelUnreachableNoAddress",
    );
  });

  test("an error status of the model's server says which", () => {
    const error = new DataError("words", { kind: "model_http_error", status: 502, upstreamStatus: 503 });
    expect(describeError(error, t)).toBe('errors.modelHttpError {"status":503}');
    const said = new DataError("words", {
      kind: "model_http_error", status: 502, upstreamStatus: 503, upstream: "Overloaded",
    });
    expect(describeError(said, t)).toBe(
      'errors.modelHttpError {"status":503} errors.upstream {"text":"Overloaded"}',
    );
  });

  test("a network failure on the model's side keeps the words it came with", () => {
    const error = new DataError("words", { kind: "model_network_error", upstream: "connection reset" });
    expect(describeError(error, t)).toBe(
      'errors.modelNetworkError errors.upstream {"text":"connection reset"}',
    );
  });

  test("a model's own error is shown with what it said", () => {
    const error = new DataError("Rate limit reached (429).", { kind: "model_error", status: 502 });
    expect(describeError(error, t)).toBe('errors.modelError {"message":"Rate limit reached (429)."}');
  });

  test("something that broke inside the server is shown with what it said", () => {
    const error = new DataError("disk on fire", { kind: "internal" });
    expect(describeError(error, t)).toBe('errors.internal {"message":"disk on fire"}');
  });

  test("a model or a crash with nothing to say is the generic sentence", () => {
    expect(describeError(new DataError("", { kind: "model_error" }), t)).toBe("errors.unexpected");
    expect(describeError(new DataError("", { kind: "internal" }), t)).toBe("errors.unexpected");
  });

  test.each([
    [90, 2], [60, 1], [1, 1], [0, 1], [901, 16], [undefined, 1],
  ])("too many attempts, retry after %j s, says %j min", (retryAfter, minutes) => {
    const error = new DataError("Too many attempts.", { kind: "rate_limited", status: 429, retryAfter });
    expect(describeError(error, t)).toBe(`errors.rateLimited {"minutes":${minutes}}`);
  });
});

describe("a missing thing", () => {
  test.each([
    ["character", "errors.notFound.character"],
    ["conversation", "errors.notFound.conversation"],
    ["message", "errors.notFound.message"],
    ["persona", "errors.notFound.persona"],
    ["connection", "errors.notFound.connection"],
    ["lore_entry", "errors.notFound.loreEntry"],
    ["fact", "errors.notFound.fact"],
    ["library_card", "errors.notFound.libraryCard"],
  ])("a %s is said as %s", (resource, key) => {
    const error = new DataError("English words", { kind: "not_found", resource, status: 404 });
    expect(describeError(error, t)).toBe(key);
  });

  test.each(["file", "illustration", "something_new", undefined])(
    "%s has the sentence for any missing thing",
    (resource) => {
      const error = new DataError("English words", { kind: "not_found", resource, status: 404 });
      expect(describeError(error, t)).toBe("errors.notFound.other");
    },
  );
});

describe("an error the request layer named", () => {
  test("an answer with nothing readable in it says its status", () => {
    const error = new DataError("HTTP 502", { kind: "http_error", status: 502 });
    expect(describeError(error, t)).toBe('errors.server {"status":502}');
  });

  test("no answer at all is Evermind not answering", () => {
    const error = new DataError("Network error", { kind: "network" });
    expect(describeError(error, t)).toBe("errors.unreachable");
  });
});

describe("an error nobody named", () => {
  test("FastAPI's refusal of what was sent is the invalid sentence", () => {
    const detail = JSON.stringify([{ loc: ["body", "name"], msg: "Field required" }]);
    expect(describeError(new DataError(detail, { status: 422 }), t)).toBe("errors.invalid");
  });

  test("a server failure without a kind says its status", () => {
    expect(describeError(new DataError("Bad gateway", { status: 502 }), t)).toBe(
      'errors.server {"status":502}',
    );
  });

  test("FastAPI's 404, for a route that is not there, is the sentence for a missing thing", () => {
    expect(describeError(new DataError("Not Found", { status: 404 }), t)).toBe("errors.notFound.other");
  });

  test.each([400, 401, 403, 405, 409, 413])(
    "any other 4xx without a kind (%i) is the generic sentence, whatever words it carries",
    (status) => {
      expect(describeError(new DataError("Method Not Allowed", { status }), t)).toBe("errors.unexpected");
    },
  );

  test("a kind this version does not know shows the server's own words", () => {
    const error = new DataError("The moon is in the wrong phase.", { kind: "lunar", status: 409 });
    expect(describeError(error, t)).toBe("The moon is in the wrong phase.");
  });

  test("a kind this version does not know, on a 4xx, shows the server's words too", () => {
    const error = new DataError("Out of moon.", { kind: "lunar", status: 404 });
    expect(describeError(error, t)).toBe("Out of moon.");
  });

  test("a kind this version does not know, on a server failure, still shows the server's words", () => {
    const error = new DataError("Out of moon.", { kind: "lunar", status: 503 });
    expect(describeError(error, t)).toBe("Out of moon.");
  });
});

describe("anything else that was thrown", () => {
  test.each([
    ["a TypeError", new TypeError("x is undefined")],
    ["a plain Error", new Error("Unexpected token < in JSON")],
    ["a string", "boom"],
    ["nothing", undefined],
  ])("%s is the generic sentence, whatever words it carries", (_name, thrown) => {
    expect(describeError(thrown, t)).toBe("errors.unexpected");
  });

  test("a sentence for the place it happened replaces the generic one", () => {
    expect(describeError(new TypeError("x"), t, "Could not install this card.")).toBe(
      "Could not install this card.",
    );
  });

  test("but never replaces what a DataError says", () => {
    const error = new DataError("HTTP 500", { kind: "http_error", status: 500 });
    expect(describeError(error, t, "Could not install this card.")).toBe(
      'errors.server {"status":500}',
    );
  });
});

describe("a failure that is not an error", () => {
  test("the error event of a reply is described like the error of a call", () => {
    expect(describeFailure({ kind: "no_connection", message: "No LLM connection configured." }, t)).toBe(
      "errors.noConnection",
    );
    expect(
      describeFailure({ kind: "not_found", resource: "conversation", message: "Conversation not found." }, t),
    ).toBe("errors.notFound.conversation");
  });

  test("an event with a model's words and status is described like the error of a call", () => {
    expect(
      describeEvent(
        { kind: "model_http_error", message: "English", upstream: "Overloaded", upstream_status: 503 },
        t,
      ),
    ).toBe('errors.modelHttpError {"status":503} errors.upstream {"text":"Overloaded"}');
  });

  test("an event that could not reach the model's server names the address", () => {
    expect(
      describeEvent(
        { kind: "unreachable", message: "English", upstream_url: "http://localhost:1234/v1" },
        t,
      ),
    ).toBe('errors.modelUnreachable {"url":"http://localhost:1234/v1"}');
  });

  test("an event that names what it did not find", () => {
    expect(
      describeEvent({ kind: "not_found", resource: "conversation", message: "English" }, t),
    ).toBe("errors.notFound.conversation");
  });

  test("an event with no kind shows its words", () => {
    expect(describeFailure({ kind: null, message: "Boom" }, t)).toBe("Boom");
  });

  test("and with no words, the generic sentence", () => {
    expect(describeFailure({ message: "" }, t)).toBe("errors.unexpected");
  });
});

describe("a result the server reports in a 200", () => {
  test("a connection test that could not reach the server names the address typed", () => {
    expect(
      describeResult(
        { detail: "Cannot reach http://x/v1.", kind: "unreachable", upstream_url: "http://x/v1" },
        t,
      ),
    ).toBe('errors.modelUnreachable {"url":"http://x/v1"}');
  });

  test("a failed connection test is described by its kind", () => {
    expect(
      describeResult(
        {
          detail: "Authentication refused (401): invalid or missing API key. bad key",
          kind: "model_auth_refused", upstream_status: 401, upstream: "bad key",
        },
        t,
      ),
    ).toBe('errors.modelAuthRefused errors.upstream {"text":"bad key"}');
  });

  test("with the status of the model's server when that is what it has to say", () => {
    expect(
      describeResult({ detail: "words", kind: "model_http_error", upstream_status: 500 }, t),
    ).toBe('errors.modelHttpError {"status":500}');
  });

  test("a failure that is not named shows its words", () => {
    expect(describeResult({ detail: "Test failed" }, t)).toBe("Test failed");
    expect(describeResult({}, t)).toBe("errors.unexpected");
  });
});

// Every key the mapping can ask for has to exist, or the person would be shown
// the key itself. The mapping is read through a translator that records them.
describe("the sentences exist", () => {
  const asked = new Set<string>();
  const record = (key: string) => {
    asked.add(key);
    return key;
  };
  const kinds = [
    "locked", "wrong_password", "too_large", "rate_limited", "cross_origin", "unknown_host",
    "png_without_card", "unrecognized_card_file", "variant_out_of_range", "already_installed",
    "lore_entry_incomplete", "fact_exists", "fact_empty", "file_too_large", "unsupported_image",
    "conversation_empty", "no_connection", "unreachable", "model_error", "model_empty",
    "model_empty_retried", "model_unreadable", "empty_message", "nothing_to_regenerate",
    "nothing_to_continue", "internal", "http_error", "network", "not_found",
    "model_auth_refused", "model_not_found", "model_rate_limited", "model_http_error",
    "model_timeout", "model_network_error", "model_unexpected_response", "model_unknown_type",
    "model_no_text",
  ];
  const resources = [
    "character", "conversation", "message", "persona", "connection", "lore_entry", "fact",
    "library_card", "illustration", "file",
  ];

  test("in English, which every other language is checked against", () => {
    for (const kind of kinds) {
      describeError(
        new DataError("words", { kind, status: 400, upstream: "words", upstreamUrl: "http://x" }),
        record,
      );
      describeError(new DataError("words", { kind, status: 400 }), record);
    }
    for (const resource of resources) {
      describeError(new DataError("words", { kind: "not_found", resource }), record);
    }
    describeError(new DataError("words", { status: 422 }), record);
    describeError(new DataError("words", { status: 404 }), record);
    describeError(new DataError("words", { status: 500 }), record);
    describeError(new DataError("words", { status: 405 }), record);
    describeError("anything", record);

    const lookup = (key: string) =>
      key.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], en);
    const missing = [...asked].filter((key) => typeof lookup(key) !== "string");
    expect(missing).toEqual([]);
    expect(asked.size).toBeGreaterThan(30);
  });
});
