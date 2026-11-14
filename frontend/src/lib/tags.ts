const same = (tag: string) => tag.trim().toLowerCase();

/** The tags with the one typed in added, unless they have it already: "Fantasy" and " fantasy" are
 *  one tag, and the card keeps the spelling it had. */
export function addTag(tags: string[], typed: string): string[] {
  const tag = typed.trim();
  return tag && !tags.some((kept) => same(kept) === same(tag)) ? [...tags, tag] : tags;
}
