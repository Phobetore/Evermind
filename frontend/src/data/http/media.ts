import type { Character, Conversation, Persona } from "@/types";

/** The server writes the address of an image from its own root, `/api/media/x.png`.
 *  Written so, it ignores the path the interface is served from: behind a
 *  reverse proxy that serves Evermind under `/evermind/`, the image would be
 *  asked of the wrong place. Without the slash it is resolved against the page,
 *  as every call is. An address that does not start from the root (another
 *  site, `data:`, `blob:`) is not the server's and stays as it is. */
export function relativeUrl(url: string): string {
  return url.startsWith("/") && !url.startsWith("//") ? url.slice(1) : url;
}

/** `item` with the address under `key` made relative, if it has one. */
function withRelative<T extends object>(item: T, key: keyof T): T {
  const url = item?.[key];
  return typeof url === "string" ? { ...item, [key]: relativeUrl(url) } : item;
}

export const characterOf = (character: Character): Character =>
  withRelative(character, "avatar_url");

export const personaOf = (persona: Persona): Persona => withRelative(persona, "avatar_url");

export function conversationOf(conversation: Conversation): Conversation {
  const result = withRelative(conversation, "wallpaper_url");
  // A conversation carries its character along, with the portrait.
  return result?.character ? { ...result, character: characterOf(result.character) } : result;
}
