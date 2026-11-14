import { describe, expect, test } from "vitest";
import { chosenNotes, isLanguageTag, languageName, notesVersions } from "./notes";

const card = (creator_notes: string, creator_notes_multilingual: Record<string, string> = {}) =>
  ({ creator_notes, creator_notes_multilingual });

describe("the notes of a card by language", () => {
  test("the main text comes first, then each language", () => {
    const versions = notesVersions(card("Main.", { ko: "문지기.", "Supprimer la fiche": "Oops.", fr: "Gardien.", "FR-ca": "Gardien, eh." }));
    expect(versions.map((version) => version.lang)).toEqual([null, "fr", "FR-ca", "ko", "Supprimer la fiche"]);
    expect(versions[0]).toEqual({ lang: null, text: "Main." });
    expect(versions[1]).toEqual({ lang: "fr", text: "Gardien." });
  });

  test("a language that repeats the main text is not offered twice", () => {
    const versions = notesVersions(card("A guardian.", { en: "  A guardian.\n", ko: "문지기." }));
    expect(versions.map((version) => version.lang)).toEqual([null, "ko"]);
  });

  test("the interface's language is chosen, then the main text, then English", () => {
    const languages = notesVersions(card("Main.", { FR: "Gardien.", en: "Keeper.", ko: "문지기." }));
    expect(languages[chosenNotes(languages, "fr")].lang).toBe("FR");
    expect(languages[chosenNotes(languages, "de")].lang).toBeNull();
    const regional = notesVersions(card("", { "fr-CA": "Gardien.", en: "Keeper.", ko: "문지기." }));
    expect(regional[chosenNotes(regional, "fr")].lang).toBe("fr-CA");
    expect(regional[chosenNotes(regional, "de")].lang).toBe("en");
    const neither = notesVersions(card("", { ko: "문지기.", ja: "門番。" }));
    expect(chosenNotes(neither, "de")).toBe(0);
    expect(chosenNotes(notesVersions(card("")), "fr")).toBe(-1);
  });

  test("blank versions are left out", () => {
    expect(notesVersions(card("  \n ", { fr: " ", ko: "", en: "Keeper." }))).toEqual([{ lang: "en", text: "Keeper." }]);
    expect(notesVersions(card("", {}))).toEqual([]);
  });

  test("a language is named in the interface's language, and an unknown code by itself", () => {
    expect(languageName("ko", "fr")).toBe("coréen");
    expect(languageName("xx", "fr")).toBe("xx");
  });

  test("a key that is no language tag is kept but never named", () => {
    for (const tag of ["fr", "pt-BR", "zh_Hant"]) expect(isLanguageTag(tag), tag).toBe(true);
    const tooLong = "en" + "-abcdefgh".repeat(3) + "-abcdef"; // 36 characters of the right form
    expect(tooLong).toHaveLength(36);
    for (const key of ["Supprimer la fiche", "x!!", "", tooLong]) expect(isLanguageTag(key), key).toBe(false);
    const versions = notesVersions(card("Main.", { "Supprimer la fiche": "Oops." }));
    expect(versions.map((version) => version.lang)).toEqual([null, "Supprimer la fiche"]);
    // These keys begin as French does, before a "-" or a "_", but are no tags: never chosen for it.
    for (const key of ["fr-la fiche", "fr_!!"]) {
      const alone = notesVersions(card("", { [key]: "Oops.", en: "Keeper." }));
      expect(alone[chosenNotes(alone, "fr")].lang, key).toBe("en");
    }
  });

  test("a card of hundreds of thousands of languages offers two hundred, in time", () => {
    const multilingual: Record<string, string> = {};
    const letters = "abcdefghijklmnopqrstuvwxyz";
    for (let i = 0; i < 200_000; i++) multilingual[`${letters[Math.floor(i / 26) % 26]}${letters[i % 26]}-${i}`] = "  ";
    for (let i = 0; i < 300; i++) multilingual[`zz-${i}`] = `Version ${i}.`;
    multilingual.fr = "Gardien.";
    const start = performance.now();
    const versions = notesVersions(card("Main.", multilingual));
    expect(performance.now() - start).toBeLessThan(150);
    expect(versions).toHaveLength(201);
    expect(versions[0].lang).toBeNull();
    // "fr" came after the two hundredth version kept, and is not among them.
    expect(versions[chosenNotes(versions, "fr")].lang).toBeNull();

    const named = performance.now();
    for (let i = 0; i < 20_000; i++) languageName("ko", "fr");
    expect(performance.now() - named).toBeLessThan(200);
  });
});
