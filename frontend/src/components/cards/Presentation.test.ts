import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";
import { I18nProvider } from "@/i18n/I18nProvider";
import { Presentation, whenLayout } from "./Presentation";

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

test("a presentation whose layout fails says why it is plain", async () => {
  // A nesting deeper than the walk of the layout goes fails in a small stack (the mock answers so).
  await new Promise<void>((done) => whenLayout(() => done(), () => done()));
  const page = renderToStaticMarkup(
    createElement(I18nProvider, { initialLocale: "en", children: createElement(Presentation, { text: "She keeps the lamp." }) }),
  );
  expect(page).toContain("She keeps the lamp.");
  expect(page).toContain("Too dense to lay out: shown without its layout.");
});
