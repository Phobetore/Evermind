import { describe, expect, test, vi } from "vitest";
import { DataError } from "@/data/errors";
import type { Translate } from "@/i18n/I18nProvider";
import { describeError } from "@/lib/errors";
import { start } from "./start";

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
    const t: Translate = (key) => key;
    expect(describeError(renderFailure.mock.calls[0][0], t)).toBe("The stored data cannot be read.");
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
