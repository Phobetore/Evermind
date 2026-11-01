import { describe, expect, test } from "vitest";
import { allowedHosts } from "./devHosts";

describe("allowedHosts", () => {
  test("a computer's name comes with its first label, and each with .local", () => {
    expect(allowedHosts("Studio.Home.Lan", "")).toEqual([
      "studio.home.lan",
      "studio",
      "studio.home.lan.local",
      "studio.local",
    ]);
  });

  test("a name without a domain has no first label of its own to add", () => {
    expect(allowedHosts("nas", "")).toEqual(["nas", "nas.local"]);
  });

  test("a computer without a name allows nothing by itself", () => {
    expect(allowedHosts("", "")).toEqual([]);
  });

  test("the names listed in EVERMIND_ALLOWED_HOSTS follow, in lower case", () => {
    expect(allowedHosts("nas", "Evermind.Example,box")).toEqual([
      "nas",
      "nas.local",
      "evermind.example",
      "box",
    ]);
  });

  test("an entry is read as the API reads it: no spaces, no port, no final dot", () => {
    expect(allowedHosts("nas", " Evermind.Example:3000 , box. , other-box ")).toEqual([
      "nas",
      "nas.local",
      "evermind.example",
      "box",
      "other-box",
    ]);
  });

  test("a name that is already allowed is not listed twice", () => {
    expect(allowedHosts("nas", "NAS,nas.local,box,box")).toEqual(["nas", "nas.local", "box"]);
  });

  test("an entry that starts with a dot allows nothing", () => {
    // Vite would take ".example.com" for every name under example.com, and the
    // API reads it as no name at all.
    expect(allowedHosts("nas", ".example.com")).toEqual(["nas", "nas.local"]);
    expect(allowedHosts("nas", ".example.com,evermind.example")).toEqual([
      "nas",
      "nas.local",
      "evermind.example",
    ]);
  });

  test.each(["*", "*.example.com", "http://box", "box/path", "bo x", "[::1]", ",", "  "])(
    "an entry that is not a host name allows nothing: %j",
    (entry) => {
      expect(allowedHosts("nas", entry)).toEqual(["nas", "nas.local"]);
    },
  );

  test.each([
    ["", ""],
    ["nas", ""],
    ["nas", "true"],
    ["nas", "*"],
    ["nas", ".example.com"],
    ["nas", "evermind.example"],
  ])("it is always a list of names, never true (machine %j, listed %j)", (machine, listed) => {
    const hosts: unknown = allowedHosts(machine, listed);
    expect(hosts).not.toBe(true);
    expect(Array.isArray(hosts)).toBe(true);
  });
});
