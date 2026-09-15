import { expect, test } from "@playwright/test";
import { API } from "../playwright.config";
import { makeCharacter, PNG } from "./fixtures";

/**
 * Next answers at /_next/image with an optimizer Evermind has never used. The
 * password gate does not cover that address, and the optimizer runs whatever
 * image it is pointed at, uploaded avatars included, through a native decoder:
 * two of the advisories fixed in Next 16.3.3 were in that decoder. It is turned
 * off in next.config.ts, and this is what notices if it ever comes back.
 */
test("the unused image optimizer cannot be reached", async ({ request }) => {
  const character = await makeCharacter(request);
  const uploaded = await request.post(`${API}/api/characters/${character.id}/avatar`, {
    multipart: { file: { name: "avatar.png", mimeType: "image/png", buffer: PNG } },
  });
  expect(uploaded.ok()).toBeTruthy();
  const { avatar_url } = await uploaded.json();

  // A real image the optimizer would otherwise resize, so the 404 cannot come
  // from it having been handed nothing worth decoding.
  const response = await request.get(
    `/_next/image?url=${encodeURIComponent(avatar_url)}&w=64&q=75`,
  );
  expect(response.status()).toBe(404);
});
