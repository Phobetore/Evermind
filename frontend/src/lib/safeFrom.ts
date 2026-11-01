/** Where to go once the password is accepted: the `from` the login was sent
 *  with when it names a page of this app, and the home page otherwise.
 *
 *  `from` arrives in the address, so anyone can write a link that fills it in.
 *  A path is only followed when it stays on this site: "//host" and "/\host"
 *  both start with a slash and still lead elsewhere, because browsers read a
 *  backslash as a forward one. */
export function safeFrom(from: string | null): string {
  if (!from || from[0] !== "/") return "/";
  if (from[1] === "/" || from[1] === "\\") return "/";
  if (from.includes("\\")) return "/";
  return from;
}
