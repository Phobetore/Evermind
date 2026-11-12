import { describe, expect, test, vi } from "vitest";
import { start } from "./start";

describe("starting the interface", () => {
  test("a store that cannot be read shows why instead of a blank page", async () => {
    const unreadable = new Error("The stored data cannot be read.");
    const ready = Promise.reject(unreadable);
    const render = vi.fn();
    const renderFailure = vi.fn();
    await start({ ready }, render, renderFailure);
    expect(render).not.toHaveBeenCalled();
    expect(renderFailure).toHaveBeenCalledWith(unreadable);
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
