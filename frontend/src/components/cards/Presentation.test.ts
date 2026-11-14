import { expect, test, vi } from "vitest";
import { whenLayout } from "./Presentation";

vi.mock("@/lib/presentation/renderPresentation", () => ({
  renderPresentation: () => ({ kind: "plain", reason: "failed" }),
}));

test("a presentation drawn while the layout arrives still gets it", async () => {
  // A first presentation asks for the layout.
  const first: unknown[] = [];
  whenLayout((render) => first.push(render), () => {});
  // A second one is drawn before the layout is here; the import ends before its effect runs.
  await vi.waitFor(() => expect(first).toHaveLength(1));
  const second: unknown[] = [];
  whenLayout((render) => second.push(render), () => {});
  // Its effect finds the layout already here, and takes it at once.
  expect(second).toEqual(first);
});
