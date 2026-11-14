import { expect, test } from "vitest";
import { linkTarget, misleadingHost } from "./links";

test("only web and mail links are followed", () => {
  expect(linkTarget("https://a.example/x")).toBe("https://a.example/x");
  expect(linkTarget("mailto:a@b.example")).toBe("mailto:a@b.example");
  for (const href of [
    "javascript:alert(1)",
    "jav\tascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "#/settings",
    "/api/characters",
    "ftp://files.example/a",
    "tel:+3300000000",
    "https://bank.example@evil.example/",
    42,
  ])
    expect(linkTarget(href)).toBeNull();
});

test("a link to the app's own address becomes its text", () => {
  expect(
    linkTarget("http://192.168.1.10:8000/#/settings", "http://192.168.1.10:8000"),
  ).toBeNull();
  expect(linkTarget("http://192.168.1.10:8000/#/settings")).toBe(
    "http://192.168.1.10:8000/#/settings",
  );
  expect(linkTarget("https://a.example/x", "http://192.168.1.10:8000")).toBe(
    "https://a.example/x",
  );
});

test("an address shown anywhere in a link's text is caught", () => {
  const caught = { real: "evil.example", shown: "bank.example" };
  expect(misleadingHost("Sign in at bank.example", "https://evil.example")).toEqual(caught);
  expect(misleadingHost("https://bank.example — official", "https://evil.example")).toEqual(caught);
  expect(misleadingHost("(bank.example)", "https://evil.example")).toEqual(caught);
  expect(misleadingHost("Visit evil.example or bank.example", "https://evil.example")).toEqual(
    caught,
  );
  expect(misleadingHost("See https://user@bank.example today", "https://evil.example")).toEqual({
    real: "evil.example",
    shown: null,
  });

  const words = "a.bc ".repeat(200_000);
  const start = performance.now();
  expect(misleadingHost(words, "https://a.bc")).toBeNull();
  expect(performance.now() - start).toBeLessThan(250);
});

test("a shown address of another site is caught", () => {
  const caught = { real: "evil.example", shown: "bank.example" };
  expect(misleadingHost("https://bank.example", "https://evil.example/x")).toEqual(caught);
  expect(misleadingHost("bank.example/login", "https://evil.example")).toEqual(caught);
  expect(misleadingHost("a@bank.example", "mailto:a@evil.example")).toEqual(caught);
  expect(misleadingHost("https://bank.example@evil.example", "https://evil.example")).toEqual({
    real: "evil.example",
    shown: null,
  });
  for (const dot of ["．", "。", "｡"])
    expect(misleadingHost("bank" + dot + "example", "https://evil.example")).toEqual(caught);
  expect(misleadingHost("bank．example", "https://bank.example")).toBeNull();
  expect(misleadingHost("bank.example‮", "https://bank.example")).toEqual({
    real: "bank.example",
    shown: null,
  });
  // A Cyrillic "а" that looks Latin.
  const lookalike = "bаnk.example";
  const found = misleadingHost(lookalike, "https://" + lookalike);
  expect(found?.real.startsWith("xn--")).toBe(true);
});

test("a link to the address it shows asks nothing", () => {
  expect(misleadingHost("www.bank.example", "https://bank.example/a")).toBeNull();
  expect(misleadingHost("Click here", "https://bank.example/a")).toBeNull();
  expect(misleadingHost("a@bank.example", "mailto:a@bank.example")).toBeNull();
});
