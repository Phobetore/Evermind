import type { Options as Schema } from "rehype-sanitize";

/** What a presentation may keep: a short list of tags, of attributes and of link schemes. Given
 *  whole to rehype-sanitize, which then reads nothing of its own default list. */
export const PRESENTATION_SCHEMA: Schema = {
  tagNames: ["p", "br", "hr", "div", "span", "center", "b", "strong", "i", "em", "u", "s", "del",
    "sub", "sup", "small", "mark", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li",
    "blockquote", "pre", "code", "table", "thead", "tbody", "tr", "th", "td", "details", "summary",
    "img", "a"],
  attributes: {                         // hast property names
    "*": ["title", "style", "align"],
    a: ["href"],
    img: ["src", "alt", "width", "height"],
    td: ["colSpan", "rowSpan"],
    th: ["colSpan", "rowSpan"],
    ol: ["start"],
    details: ["open"],
  },
  protocols: { href: ["http", "https", "mailto"], src: ["http", "https", "data"] },
  // Removed with what they hold: the rest of an element not listed is unwrapped, its text kept.
  strip: ["script", "style", "template", "noscript", "iframe", "frame", "frameset", "object", "embed",
    "svg", "math", "textarea", "select", "button", "title", "head", "audio", "video", "canvas",
    "xmp", "noembed", "noframes", "plaintext"],
  clobberPrefix: "",
  clobber: [],
  allowComments: false,
  allowDoctypes: false,
};
