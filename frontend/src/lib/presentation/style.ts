import styleToObject from "style-to-object";

/** The values of `color` that take the parent's colour: inherit, currentcolor, unset, revert,
 *  revert-layer (refused anyway by the colour grammar, which does not list it; listed here so
 *  that a wider grammar would not let it pass as opaque). */
export const INHERITED_COLOR: ReadonlySet<string> = new Set([
  "inherit",
  "currentcolor",
  "unset",
  "revert",
  "revert-layer",
]);

/** The 148 colour names of CSS Color 4 §6.1 (written out in full, copied from the table of the
 *  specification, grey and gray alike), plus transparent and currentcolor: the only colour words
 *  kept. Every browser reads each of them; a word one would throw away would leave the element
 *  the colour it inherits, while cardRules would count another. */
export const NAMED_COLORS: ReadonlySet<string> = new Set([
  "aliceblue", "antiquewhite", "aqua", "aquamarine", "azure", "beige", "bisque", "black",
  "blanchedalmond", "blue", "blueviolet", "brown", "burlywood", "cadetblue", "chartreuse",
  "chocolate", "coral", "cornflowerblue", "cornsilk", "crimson", "cyan", "darkblue", "darkcyan",
  "darkgoldenrod", "darkgray", "darkgreen", "darkgrey", "darkkhaki", "darkmagenta",
  "darkolivegreen", "darkorange", "darkorchid", "darkred", "darksalmon", "darkseagreen",
  "darkslateblue", "darkslategray", "darkslategrey", "darkturquoise", "darkviolet", "deeppink",
  "deepskyblue", "dimgray", "dimgrey", "dodgerblue", "firebrick", "floralwhite", "forestgreen",
  "fuchsia", "gainsboro", "ghostwhite", "gold", "goldenrod", "gray", "green", "greenyellow",
  "grey", "honeydew", "hotpink", "indianred", "indigo", "ivory", "khaki", "lavender",
  "lavenderblush", "lawngreen", "lemonchiffon", "lightblue", "lightcoral", "lightcyan",
  "lightgoldenrodyellow", "lightgray", "lightgreen", "lightgrey", "lightpink", "lightsalmon",
  "lightseagreen", "lightskyblue", "lightslategray", "lightslategrey", "lightsteelblue",
  "lightyellow", "lime", "limegreen", "linen", "magenta", "maroon", "mediumaquamarine",
  "mediumblue", "mediumorchid", "mediumpurple", "mediumseagreen", "mediumslateblue",
  "mediumspringgreen", "mediumturquoise", "mediumvioletred", "midnightblue", "mintcream",
  "mistyrose", "moccasin", "navajowhite", "navy", "oldlace", "olive", "olivedrab", "orange",
  "orangered", "orchid", "palegoldenrod", "palegreen", "paleturquoise", "palevioletred",
  "papayawhip", "peachpuff", "peru", "pink", "plum", "powderblue", "purple", "rebeccapurple",
  "red", "rosybrown", "royalblue", "saddlebrown", "salmon", "sandybrown", "seagreen", "seashell",
  "sienna", "silver", "skyblue", "slateblue", "slategray", "slategrey", "snow", "springgreen",
  "steelblue", "tan", "teal", "thistle", "tomato", "turquoise", "violet", "wheat", "white",
  "whitesmoke", "yellow", "yellowgreen",
  "transparent", "currentcolor",
]);

// A number without sign or exponent (12, 0.5, .5), and the same followed by %.
const N = String.raw`(?:\d+(?:\.\d+)?|\.\d+)`;
const P = N + "%";
const S = String.raw`\s*`;
const RGB = new RegExp(
  "^rgba?\\(" + S + "(?:" +
    [
      `${N}${S},${S}${N}${S},${S}${N}(?:${S},${S}${N})?`,
      `${P}${S},${S}${P}${S},${S}${P}(?:${S},${S}${N})?`,
      `${N}\\s+${N}\\s+${N}(?:${S}/${S}${N})?`,
      `${P}\\s+${P}\\s+${P}(?:${S}/${S}${N})?`,
    ].join("|") +
    ")" + S + "\\)$",
);
const HSL = new RegExp(
  "^hsla?\\(" + S + "(?:" +
    [
      `${N}${S},${S}${P}${S},${S}${P}(?:${S},${S}${N})?`,
      `${N}\\s+${P}\\s+${P}(?:${S}/${S}${N})?`,
    ].join("|") +
    ")" + S + "\\)$",
);
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/;

/** Whether a value, already in lower case, is one of the colour forms every targeted browser
 *  reads (Chrome and Edge 111, Firefox 114, Safari 16.4): a name, #hex, rgb()/rgba(), hsl()/hsla()
 *  without mixing numbers and percentages. */
function isColor(value: string): boolean {
  if (NAMED_COLORS.has(value)) return true;
  if (value.startsWith("#")) return HEX.test(value);
  if (value.startsWith("rgb")) return RGB.test(value);
  if (value.startsWith("hsl")) return HSL.test(value);
  return false;
}

/** The alpha of a colour as cleanDeclarations keeps it, from 0 to 1: 1 when it writes none
 *  (a name, #rgb, #rrggbb, rgb(r, g, b)), 0 for transparent. The keywords that take the
 *  inherited colour (INHERITED_COLOR) answer 1 here: cardRules never lets them reset its count. */
export function colorAlpha(color: string): number {
  const value = color.trim().toLowerCase();
  if (value === "transparent") return 0;
  let alpha = 1;
  if (/^#[0-9a-f]{4}$/.test(value)) alpha = parseInt(value[4], 16) / 15;
  else if (/^#[0-9a-f]{8}$/.test(value)) alpha = parseInt(value.slice(7), 16) / 255;
  else if (/^(?:rgba?|hsla?)\(/.test(value)) {
    const inside = value.slice(value.indexOf("(") + 1, value.lastIndexOf(")"));
    const slash = inside.indexOf("/");
    if (slash >= 0) alpha = parseFloat(inside.slice(slash + 1));
    else {
      const parts = inside.split(",");
      if (parts.length === 4) alpha = parseFloat(parts[3]);
    }
  }
  if (Number.isNaN(alpha)) return 1;
  return Math.min(1, Math.max(0, alpha));
}

// Below this alpha a text is barely seen and can carry a hidden message (decision 1).
const FAINTEST = 0.3;

/** The words of a value at the top level: split at blanks (or at commas), never inside the
 *  parentheses of a colour function. */
function split(value: string, separator: "blank" | "comma"): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of value) {
    if (char === "(") depth++;
    else if (char === ")") depth = Math.max(0, depth - 1);
    const breaks = separator === "blank" ? /\s/.test(char) : char === ",";
    if (depth === 0 && breaks) {
      if (current.trim() !== "") parts.push(current.trim());
      current = "";
    } else current += char;
  }
  if (current.trim() !== "") parts.push(current.trim());
  return parts;
}

const LENGTH = /^(-?)((?:\d+(?:\.\d+)?|\.\d+))(px|pt|em|rem|%)?$/;

interface Length {
  px: number;
  percent: boolean;
  negative: boolean;
}

/** A length as the browsers read it, relative units rewritten in px (pt × 4/3, em and rem × 16);
 *  0 may go without its unit; null for anything else. */
function readLength(word: string): Length | null {
  const found = LENGTH.exec(word);
  if (!found) return null;
  const number = parseFloat(found[2]);
  const unit = found[3];
  if (unit === undefined && number !== 0) return null;
  const negative = found[1] === "-" && number !== 0;
  if (unit === "%") return { px: number, percent: true, negative };
  const scale = unit === "pt" ? 4 / 3 : unit === "em" || unit === "rem" ? 16 : 1;
  return { px: number * scale, percent: false, negative };
}

function px(value: number): string {
  return Math.round(value * 100) / 100 + "px";
}

/** A length of 0 to `max` px, rewritten in px; `auto` too when allowed. */
function boundedLength(word: string, max: number, auto: boolean): string | null {
  if (auto && word === "auto") return "auto";
  const length = readLength(word);
  if (!length || length.percent || length.negative || length.px > max) return null;
  return px(length.px);
}

/** 1 to 4 values of one kind, the shape of CSS's four-side shorthands. */
function sides(value: string, read: (word: string) => string | null): string | null {
  const words = split(value, "blank");
  if (words.length < 1 || words.length > 4) return null;
  const kept: string[] = [];
  for (const word of words) {
    const one = read(word);
    if (one === null) return null;
    kept.push(one);
  }
  return kept.join(" ");
}

const BORDER_STYLES = new Set(["none", "solid", "dashed", "dotted", "double"]);
const BORDER_WIDTHS: Record<string, number> = { thin: 1, medium: 3, thick: 5 };

function borderWidth(word: string): string | null {
  if (word in BORDER_WIDTHS) return word;
  return boundedLength(word, 16, false);
}

/** 1 to 3 words of a border: a width, a style, a colour, each at most once. */
function border(value: string): string | null {
  const words = split(value, "blank");
  if (words.length < 1 || words.length > 3) return null;
  let width = false;
  let style = false;
  let color = false;
  const kept: string[] = [];
  for (const word of words) {
    if (!style && BORDER_STYLES.has(word)) {
      style = true;
      kept.push(word);
      continue;
    }
    if (!width) {
      const one = borderWidth(word);
      if (one !== null) {
        width = true;
        kept.push(one);
        continue;
      }
    }
    if (!color && isColor(word)) {
      color = true;
      kept.push(word);
      continue;
    }
    return null;
  }
  return kept.join(" ");
}

const DECORATION_WORDS = new Set([
  "none", "underline", "overline", "line-through", "solid", "double", "dotted", "dashed", "wavy",
]);

function textShadow(value: string): string | null {
  if (value === "none") return value;
  const shadows = split(value, "comma");
  if (shadows.length < 1 || shadows.length > 2) return null;
  const kept: string[] = [];
  for (const shadow of shadows) {
    const words = split(shadow, "blank");
    let color: string | null = null;
    if (words.length > 0 && isColor(words[0])) color = words.shift()!;
    else if (words.length > 0 && isColor(words[words.length - 1])) color = words.pop()!;
    if (words.length < 2 || words.length > 3) return null;
    const lengths: string[] = [];
    for (let i = 0; i < words.length; i++) {
      const length = readLength(words[i]);
      if (!length || length.percent) return null;
      const signed = length.negative ? -length.px : length.px;
      // Offsets lean at most 4 px either way; a blur spreads at most 8 px.
      if (i < 2 ? Math.abs(signed) > 4 : signed < 0 || signed > 8) return null;
      lengths.push(px(signed));
    }
    kept.push([...lengths, ...(color ? [color] : [])].join(" "));
  }
  return kept.join(", ");
}

function between(word: string, low: number, high: number, percent: boolean): boolean {
  const found = new RegExp(`^${N}${percent ? "%" : ""}$`).exec(word);
  if (!found) return false;
  const number = parseFloat(word) / (percent ? 100 : 1);
  return number >= low && number <= high;
}

/** The value kept for a property of the table, or null when it is dropped. */
const PROPERTIES: Record<string, (value: string) => string | null> = {
  color: (value) => {
    if (value === "inherit" || value === "initial" || value === "unset" || value === "revert")
      return value;
    return isColor(value) && colorAlpha(value) >= FAINTEST ? value : null;
  },
  "background-color": (value) => (isColor(value) ? value : null),
  background: (value) => (isColor(value) ? value : null),
  "font-size": (value) => {
    if (value === "small" || value === "medium" || value === "large" || value === "x-large")
      return value;
    const length = readLength(value);
    if (!length || length.negative) return null;
    const size = length.percent ? length.px * 0.16 : length.px;
    // Under 11 px a text cannot be read on a phone; over 32 px a long word leaves its screen.
    return size >= 11 && size <= 32 ? px(size) : null;
  },
  "font-weight": (value) => {
    if (["normal", "bold", "bolder", "lighter"].includes(value)) return value;
    if (!/^\d+$/.test(value)) return null;
    const weight = Number(value);
    return weight >= 1 && weight <= 1000 ? value : null;
  },
  "font-style": (value) => (["normal", "italic", "oblique"].includes(value) ? value : null),
  "text-align": (value) =>
    ["left", "right", "center", "justify", "start", "end"].includes(value) ? value : null,
  "text-decoration": (value) => {
    const words = split(value, "blank");
    if (words.length < 1 || words.length > 3) return null;
    return words.every((word) => DECORATION_WORDS.has(word) || isColor(word)) ? words.join(" ") : null;
  },
  // Only a number without unit follows the size of the element and of each of its children.
  "line-height": (value) => (value === "normal" || between(value, 1, 3, false) ? value : null),
  margin: (value) => sides(value, (word) => boundedLength(word, 64, true)),
  "margin-top": (value) => boundedLength(value, 64, true),
  "margin-right": (value) => boundedLength(value, 64, true),
  "margin-bottom": (value) => boundedLength(value, 64, true),
  "margin-left": (value) => boundedLength(value, 64, true),
  padding: (value) => sides(value, (word) => boundedLength(word, 64, false)),
  "padding-top": (value) => boundedLength(value, 64, false),
  "padding-right": (value) => boundedLength(value, 64, false),
  "padding-bottom": (value) => boundedLength(value, 64, false),
  "padding-left": (value) => boundedLength(value, 64, false),
  border,
  "border-top": border,
  "border-right": border,
  "border-bottom": border,
  "border-left": border,
  "border-width": (value) => sides(value, borderWidth),
  "border-style": (value) => sides(value, (word) => (BORDER_STYLES.has(word) ? word : null)),
  "border-color": (value) => sides(value, (word) => (isColor(word) ? word : null)),
  "border-radius": (value) =>
    sides(value, (word) => {
      const length = readLength(word);
      if (!length || length.negative) return null;
      return length.percent ? word : px(length.px);
    }),
  width: (value) => {
    if (value === "auto") return value;
    const length = readLength(value);
    if (!length || length.negative) return null;
    if (length.percent) return length.px <= 100 ? value : null;
    return px(length.px);
  },
  // max-width: auto does not exist in CSS: the browser would throw it away.
  "max-width": (value) => {
    const length = readLength(value);
    if (!length || length.negative) return null;
    if (length.percent) return length.px <= 100 ? value : null;
    return px(length.px);
  },
  opacity: (value) =>
    between(value, FAINTEST, 1, false) || between(value, FAINTEST, 1, true) ? value : null,
  display: (value) => (["block", "inline", "inline-block", "flex"].includes(value) ? value : null),
  "text-shadow": textShadow,
};

const ALLOWED_FUNCTIONS = new Set(["rgb", "rgba", "hsl", "hsla"]);

/** Whether a value loads, escapes or computes something: url(), expression, @, \, comments,
 *  !important, a tag, or any function but the four colour ones. */
function unsafe(value: string): boolean {
  if (/url\(|expression|@|\\|\/\*|!|</.test(value)) return true;
  // The name before each "(", read backwards: the names of two "(" never overlap, so each
  // character is read once.
  for (let open = value.indexOf("("); open >= 0; open = value.indexOf("(", open + 1)) {
    let start = open;
    while (start > 0 && /[a-z0-9_-]/.test(value[start - 1])) start--;
    if (!ALLOWED_FUNCTIONS.has(value.slice(start, open))) return true;
  }
  return false;
}

/** Whether style-to-object would take more than linear time on this style: its value
 *  expression looks for the ")" of each "(" to the end of the text, so thousands of "(" without
 *  one would freeze the page. */
function tooTangled(style: string): boolean {
  let nextClose = style.length;
  let reach = 0;
  for (let i = style.length - 1; i >= 0; i--) {
    const code = style.charCodeAt(i);
    if (code === 41) nextClose = i;
    else if (code === 40) reach += nextClose - i;
  }
  return reach > 4 * style.length + 1_000;
}

/** The declarations of an inline style that stay in their box, in their order, each value as kept
 *  (relative lengths rewritten in px); [] when none does. Parsed by style-to-object; a style it
 *  cannot read keeps nothing. A name kept twice keeps only its last kept declaration: the one the
 *  browser applies, and the one cardRules counts. */
export function cleanDeclarations(written: string): Array<[name: string, value: string]> {
  if (typeof written !== "string" || written.trim() === "" || tooTangled(written)) return [];
  // The parser trims each value with an expression tried from every blank of a run, and looks
  // for the end of a comment from every "/*" without one: each a time that grows as the square of
  // the run. A run of blanks is one blank to CSS (no kept value holds a quoted string), and a
  // comment left open would swallow the rest of the style anyway.
  const style = written.replace(/\s+/g, " ");
  const lastOpen = style.lastIndexOf("/*");
  if (lastOpen >= 0 && style.indexOf("*/", lastOpen + 2) < 0) return [];
  const read: Array<[string, string]> = [];
  try {
    styleToObject(style, (property, value, declaration) => {
      // The parser takes comments out of a value; the text it was read from still has them. One
      // line since the blanks were joined: a column is an offset.
      const position = declaration.position;
      const raw =
        position?.start && position?.end ? style.slice(position.start.column - 1, position.end.column - 1) : value;
      if (raw.includes("/*")) return;
      read.push([property.trim().toLowerCase(), value.trim().toLowerCase()]);
    });
  } catch {
    return [];
  }
  const kept: Array<[string, string]> = [];
  const last = new Map<string, number>();
  for (const [name, value] of read) {
    if (name.startsWith("-") || !Object.hasOwn(PROPERTIES, name)) continue;
    if (value === "" || unsafe(value)) continue;
    const clean = PROPERTIES[name](value);
    if (clean === null) continue;
    last.set(name, kept.length);
    kept.push([name, clean]);
  }
  return kept.filter(([name], index) => last.get(name) === index);
}

/** cleanDeclarations written back as "name: value; …"; "" when none is kept. */
export function cleanStyle(style: string): string {
  return cleanDeclarations(style)
    .map(([name, value]) => `${name}: ${value}`)
    .join("; ");
}
