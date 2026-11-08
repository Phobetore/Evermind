import { describe, expect, test } from "vitest";
import { DataError } from "@/data/errors";
import de from "@/i18n/locales/de.json";
import en from "@/i18n/locales/en.json";
import es from "@/i18n/locales/es.json";
import fr from "@/i18n/locales/fr.json";
import { describeError, describeFailure } from "./errors";

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
    ["model_connection_lost", "errors.modelNetworkError"],
    ["model_no_text", "errors.modelNoText"],
    ["model_empty", "errors.modelEmpty"],
    ["model_unreadable", "errors.modelUnreadable"],
    ["empty_message", "errors.emptyMessage"],
    ["nothing_to_regenerate", "errors.nothingToRegenerate"],
    ["nothing_to_continue", "errors.nothingToContinue"],
  ])("%s is said as %s", (kind, key) => {
    expect(describeError(new DataError("English words", { kind, status: 400 }), t)).toBe(
      `${key} {"message":"English words"}`,
    );
  });

  test.each([
    ["unreachable", "errors.modelUnreachable"],
    ["model_auth_refused", "errors.modelAuthRefused"],
    ["model_not_found", "errors.modelNotFound"],
    ["model_rate_limited", "errors.modelRateLimited"],
    ["model_error", "errors.modelError"],
    ["internal", "errors.internal"],
  ])("%s is %s, which quotes what the server said", (kind, key) => {
    const error = new DataError("Incorrect key.", { kind, status: 502 });
    expect(describeError(error, t)).toBe(`${key} {"message":"Incorrect key."}`);
  });

  test.each(["modelUnreachable", "modelAuthRefused", "modelNotFound", "modelRateLimited", "modelError",
    "internal"] as const)("errors.%s has a place for the server's words in every language", (key) => {
    for (const locale of [en, fr, de, es]) expect(locale.errors[key]).toContain("{message}");
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
    ["fact", "errors.notFound.fact"],
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
    expect(describeError(error, t)).toBe('errors.unreachable {"message":"Network error"}');
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
  test("how a reply failed is described like the error of a call", () => {
    expect(describeFailure({ kind: "unreachable", message: "http://localhost:1234/v1" }, t)).toBe(
      'errors.modelUnreachable {"message":"http://localhost:1234/v1"}',
    );
    expect(describeFailure({ kind: "model_error", message: "Overloaded" }, t)).toBe(
      'errors.modelError {"message":"Overloaded"}',
    );
  });

  test("one with no kind shows its words", () => {
    expect(describeFailure({ kind: null, message: "Boom" }, t)).toBe("Boom");
  });

  test("and with no words, the generic sentence", () => {
    expect(describeFailure({ message: "" }, t)).toBe("errors.unexpected");
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
    "png_without_card", "unrecognized_card_file", "variant_out_of_range", "fact_exists",
    "fact_empty", "memory_busy", "facts_changed", "conversation_changed", "too_few_facts",
    "file_too_large", "unsupported_image",
    "conversation_empty", "no_connection", "unreachable", "model_connection_lost",
    "model_auth_refused", "model_not_found", "model_rate_limited", "model_error", "model_no_text",
    "model_empty", "model_unreadable", "empty_message", "nothing_to_regenerate",
    "nothing_to_continue", "turn_running", "internal", "http_error", "network", "offline", "not_sent",
    "not_found",
  ];
  const resources = [
    "character", "conversation", "message", "persona", "connection", "fact", "illustration", "file",
  ];

  test("in English, which every other language is checked against", () => {
    for (const kind of kinds) describeError(new DataError("words", { kind, status: 400 }), record);
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
