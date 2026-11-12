import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { DataError } from "@/data/errors";
import type { Translate } from "@/i18n/I18nProvider";
import { translate } from "@/i18n/translate";
import { start } from "./start";
import { StartFailure } from "./StartFailure";

describe("starting the interface", () => {
  test("a store that cannot be read shows why instead of a blank page", async () => {
    // The contract asks a store that cannot be read to reject with a DataError, so the page can word it.
    const unreadable = new DataError("The stored data cannot be read.", { kind: "storage_unreadable" });
    const ready = Promise.reject(unreadable);
    const render = vi.fn();
    const renderFailure = vi.fn();
    await start({ ready }, render, renderFailure);
    expect(render).not.toHaveBeenCalled();
    expect(renderFailure).toHaveBeenCalledWith(unreadable);
    // What main.tsx draws for that error: the sentence that says why, and a way to try again.
    const t: Translate = (key, vars) => translate("en", key, vars);
    const page = renderToString(createElement(StartFailure, { error: renderFailure.mock.calls[0][0], t }));
    expect(page).toContain('role="alert"');
    expect(page).toContain("The stored data cannot be read.");
    expect(page).toMatch(/<button[^>]*>.*Reload<\/button>/);
  });

  test("a store that can be read draws the application once it is", async () => {
    let settle!: () => void;
    const ready = new Promise<void>((resolve) => (settle = resolve));
    const render = vi.fn();
    const renderFailure = vi.fn();
    const started = start({ ready }, render, renderFailure);
    await Promise.resolve();
    expect(render, "nothing is drawn before the store is read").not.toHaveBeenCalled();
    settle();
    await started;
    expect(render).toHaveBeenCalledOnce();
    expect(renderFailure).not.toHaveBeenCalled();
  });
});
