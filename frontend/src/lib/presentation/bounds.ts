// No import at all, so the page and the conversation can read the bounds without pulling the
// layout code into the main bundle. Each bound has one real reason, written next to it.

/** A hundred times the longest presentation of the sample of 288 cards; what the cost below does
 *  not count (plain prose, and the plain text a mark sends the parser back over) stays in time. */
export const LAYOUT_BOUND = 100_000;
/** What the Markdown parser may go over again (layoutCost) for a text to be laid out in a quarter
 *  of a second on a computer, a second on a phone. */
export const LAYOUT_COST_BOUND = 1_200_000;
/** What one mark costs on its own through the whole chain, parser, trees, React and the page. */
export const MARK_COST = 500;
/** Formatting elements the HTML parser may rebuild in each block before it reads anything. */
export const REBUILT_BOUND = 5_000;
/** Characters of attributes the HTML parser may copy into rebuilt elements. */
export const COPIED_BOUND = 1_000_000;
/** The squared count of attribute names on one tag: the parser compares each with the others. */
export const ATTRIBUTE_NAMES_BOUND = 4_000_000;
/** The slots the cells of one table cover, each its columns times its rows, added up; past it the
 *  table loses its spans. Each span is bounded alone (1 to 100), but two thousand of them made a
 *  grid of 220,000 columns that the browser took 51 s to lay out; at this budget, 56 ms at most. */
export const SPAN_BUDGET = 10_000;
/** Elements nested deeper are unwrapped: rendering and the browser's layout are recursive. */
export const DEPTH_BOUND = 64;
/** The payload of all the images written into a presentation, together: two 3 MB banners. */
export const INLINE_IMAGES_BOUND = 8 * 1024 * 1024;
/** 4096 × 4096 pixels per image, 64 MB once decoded: a 4K banner fits. */
export const PIXEL_BOUND = 16_777_216;
/** The pixels of every image written into one presentation, together: 256 MB once decoded. */
export const INLINE_PIXEL_BUDGET = 67_108_864;
/** How much of a text shown without layout is shown at once. */
export const PLAIN_PART = 200_000;
/** The browser's own layout of a line of text, past the parsers, grows as the square of its
 *  characters of any script but the simplest (Latin, Greek, Cyrillic): a block of n of them costs
 *  n² / SCRIPT_BLOCK, and in a text shown plainly (white-space: pre-wrap, dearer) a line of n of
 *  them n² / PLAIN_SCRIPT_LINE. Measured on 15/11 in Chromium on the PC, 100,000 characters on
 *  one line: Hangul 0.36 s laid out, 3.4 s plain; Chinese 0.38 s; Hebrew 0.22 s, 1.3 s plain;
 *  Latin 6 ms. */
export const SCRIPT_BLOCK = 2_000;
export const PLAIN_SCRIPT_LINE = 400;
/** A run of Thai, Lao, Khmer or Myanmar without a blank is broken into lines by a dictionary, at
 *  a cost that grows as the square of the run: n² / DICTIONARY_RUN. 100,000 Thai letters without
 *  a space, 2.1 s; the same cut every 200 letters, 38 ms. */
export const DICTIONARY_RUN = 400;
/** A change of direction (right-to-left against left-to-right) makes a run of its own for the
 *  browser's layout: MARK_COST with nothing between the two, SPACED_CHANGE across a blank. 100,000
 *  characters that change direction at each one, 3.2 s; each change across a blank costs about a
 *  quarter. */
export const SPACED_CHANGE = 62;
/** A run of a script the browser finds no font for among those it knows, which it looks for again
 *  at each run, through the system: FONTLESS_RUN for the scripts Windows has no font for
 *  (Samaritan, Tagalog, Balinese, Linear B, Chakma, Hanifi Rohingya…), about 2 ms each in
 *  Chromium on the PC; HISTORIC_RUN for those its historic and supplementary fonts hold (Syriac,
 *  Gothic, Phoenician, Cuneiform, Adlam…), 0.5 to 0.8 ms each (measured on 15/11, every script of
 *  Unicode written letter by letter between Latin letters). Blanks, digits and punctuation do not
 *  end a run; a letter of another script, an emoji or a line does: 99 paragraphs of Phoenician
 *  against Latin held Chromium 17 s. At the bound, 80 runs of the first or 200 of the second, 170
 *  ms. A text written in one of these scripts makes a run of each paragraph. */
export const FONTLESS_RUN = 15_000;
export const HISTORIC_RUN = 6_000;

const enum Kind {
  Comment,
  Instruction,
  Cdata,
  Declaration,
}

// What each HTML opener waits for, and how long its own characters are: an end that starts
// inside the opener does not close it.
const OPENER_LENGTH = [4, 2, 9, 2];
const END_LENGTH = [3, 2, 3, 1];

// What the parser goes over again for a label, at its "]": every character from its "[" (it
// serialises the span to look the label up), and far more for each blank, which splits that
// span into pieces it normalises one by one; twice as much for an image's label.
const LABEL_CHARACTERS = 80;
const LABEL_BLANK = 1;
const IMAGE_LABEL = 2;

interface Label {
  at: number;
  blanks: number;
  image: boolean;
}

// What a "<" may have opened, as micromark ends it: a tag (open or closing) or an autolink at the
// next ">" outside quotes, the others at their own end.
const enum Angle {
  None,
  Tag,
  Comment,
  Instruction,
  Cdata,
  Declaration,
}

const enum Direction {
  None,
  Left,
  Right,
  // Digits after a right-to-left letter, which run on their own level.
  RightDigits,
}

/** 1 for a letter written left to right, 2 for one written right to left, 3 for a digit, 0 for
 *  anything else (a blank, a mark, punctuation, an emoji): a reading of the Unicode bidirectional
 *  classes by ranges, enough to count changes of direction. `code` is a whole code point: the
 *  right-to-left scripts past the first plane (Phoenician, Adlam, Hanifi Rohingya…) are written
 *  as surrogate pairs, and change direction as Hebrew does (99 paragraphs of Phoenician against
 *  Latin, 17 s of Chromium's layout on the PC, 15/11). */
function strongOf(code: number): number {
  if (code >= 0x10000) {
    if ((code >= 0x10800 && code <= 0x10fff) || (code >= 0x1e800 && code <= 0x1efff)) return 2;
    // Mathematical digits; emoji and symbols; tags and variation selectors.
    if (code >= 0x1d7ce && code <= 0x1d7ff) return 3;
    if ((code >= 0x1f000 && code <= 0x1fbff) || code >= 0xe0000) return 0;
    return 1;
  }
  if (code < 0x80) {
    if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) return 1;
    return code >= 48 && code <= 57 ? 3 : 0;
  }
  if (code < 0x0590) return code >= 0xc0 && code !== 0xd7 && code !== 0xf7 && !(code >= 0x300 && code <= 0x36f) ? 1 : 0;
  if (code <= 0x08ff) {
    if ((code >= 0x660 && code <= 0x669) || (code >= 0x6f0 && code <= 0x6f9)) return 3;
    // The points of Hebrew and the vowels of Arabic take the direction of their letter.
    if ((code >= 0x591 && code <= 0x5c7) || (code >= 0x610 && code <= 0x61a) || (code >= 0x64b && code <= 0x65f)) return 0;
    if (code === 0x670 || (code >= 0x6d6 && code <= 0x6ed)) return 0;
    return 2;
  }
  if ((code >= 0xfb1d && code <= 0xfdff) || (code >= 0xfe70 && code <= 0xfefe)) return 2;
  if ((code >= 0x2000 && code <= 0x2bff) || (code >= 0x3000 && code <= 0x303f)) return 0;
  if ((code >= 0xd800 && code <= 0xdfff) || (code >= 0xfe00 && code <= 0xfe0f) || (code >= 0xff00 && code <= 0xff20)) return 0;
  return 1;
}

// The blocks of the scripts of HISTORIC_RUN, then of FONTLESS_RUN, as first and last code points.
const HISTORIC_BLOCKS = [
  0x0700, 0x074f, 0x0860, 0x086f, 0xa6a0, 0xa6ff, 0x10280, 0x102df, 0x10300, 0x1034f, 0x10380, 0x104ff,
  0x10800, 0x1085f, 0x10900, 0x1093f, 0x109a0, 0x109ff, 0x10a00, 0x10a7f, 0x10b40, 0x10b7f, 0x10c00,
  0x10c4f, 0x11000, 0x1107f, 0x12000, 0x1254f, 0x13000, 0x143ff, 0x16800, 0x16a3f, 0x1e900, 0x1e95f,
];
const FONTLESS_BLOCKS = [
  0x0800, 0x085f, 0x1700, 0x177f, 0x1900, 0x194f, 0x1a20, 0x1aaf, 0x1b00, 0x1c4f, 0x1cc0, 0x1ccf,
  0xa800, 0xa82f, 0xa880, 0xa8df, 0xa900, 0xa95f, 0xaa00, 0xaa5f, 0xaa80, 0xaaff, 0xabc0, 0xabff,
  // The rest of the supplementary letters but the kana, Tangut and Khitan, and the historic ones
  // above, which are read first.
  0x10000, 0x16fdf, 0x1b170, 0x1bcaf, 0x1e000, 0x1e8df, 0x1e960, 0x1efff,
];

function inBlocks(blocks: number[], code: number): number {
  for (let i = 0; i < blocks.length; i += 2) if (code >= blocks[i] && code <= blocks[i + 1]) return blocks[i];
  return -1;
}

/** The block of a character's script when the browser looks for its font at each run, -1 for any
 *  other; the cost of its run is fallbackCost's. A number, not a pair: it is read for every
 *  character of megabytes of text. */
function fallbackOf(code: number): number {
  if (code < 0x0700 || (code >= 0x1d00 && code < 0xa6a0) || (code >= 0xac00 && code < 0x10000)) return -1;
  const block = inBlocks(HISTORIC_BLOCKS, code);
  return block >= 0 ? block : inBlocks(FONTLESS_BLOCKS, code);
}

function fallbackCost(block: number): number {
  return inBlocks(HISTORIC_BLOCKS, block) >= 0 ? HISTORIC_RUN : FONTLESS_RUN;
}

/** A blank, a digit, punctuation or a mark: what goes on with the run of the script around it. */
function keepsRun(code: number): boolean {
  if (code < 0x80) return !((code >= 65 && code <= 90) || (code >= 97 && code <= 122));
  return code === 0xa0 || (code >= 0x300 && code <= 0x36f) || (code >= 0x2000 && code <= 0x206f) || (code >= 0xfe00 && code <= 0xfe0f);
}

/** Thai, Lao, Myanmar and Khmer: scripts broken into lines by a dictionary. */
function isDictionary(code: number): boolean {
  return (code >= 0x0e00 && code <= 0x0eff) || (code >= 0x1000 && code <= 0x109f) || (code >= 0x1780 && code <= 0x17ff);
}

/** What the browser's layout pays for the characters of a line beyond the parsers: the changes
 *  of direction, the runs of a dictionary script and the runs of a script it looks a font up for,
 *  read one character at a time; the square of the other scripts is the caller's, by block or by
 *  line. */
interface Script {
  direction: Direction;
  spaced: boolean;
  run: number;
  // The block of the script whose run goes on, or -1.
  font: number;
  cost: number;
}

const newScript = (): Script => ({ direction: Direction.None, spaced: false, run: 0, font: -1, cost: 0 });

function startLine(script: Script) {
  script.direction = Direction.None;
  script.spaced = false;
  script.run = 0;
  script.font = -1;
}

/** Reads the character at `index`: a whole code point at the first half of a surrogate pair, and
 *  nothing at the second. */
function readScriptAt(script: Script, text: string, index: number, code: number) {
  // A Latin letter after another, most of any text and of megabytes of images, read at once.
  if (script.direction === Direction.Left && ((code >= 65 && code <= 90) || (code >= 97 && code <= 122))) {
    script.spaced = false;
    script.run = 0;
    script.font = -1;
    return;
  }
  if (code < 0xd800) return readScript(script, code);
  if (code >= 0xdc00 && code <= 0xdfff && index > 0) {
    const high = text.charCodeAt(index - 1);
    if (high >= 0xd800 && high <= 0xdbff) return;
  }
  readScript(script, code >= 0xd800 && code <= 0xdbff ? text.codePointAt(index)! : code);
}

function readScript(script: Script, code: number) {
  const strong = strongOf(code);
  if (strong === 0) {
    if (code === 32 || code === 9) script.spaced = true;
  } else {
    const was = script.direction;
    let next = was;
    if (strong === 1) next = Direction.Left;
    else if (strong === 2) next = Direction.Right;
    else if (was === Direction.Right) next = Direction.RightDigits;
    if (was !== Direction.None && next !== was) script.cost += script.spaced ? SPACED_CHANGE : MARK_COST;
    script.direction = next;
    script.spaced = false;
  }
  // Latin letters, digits, blanks and punctuation, most of any text and of megabytes of images:
  // no dictionary, and no font looked up.
  if (code < 0x80) {
    script.run = 0;
    if (script.font >= 0 && !keepsRun(code)) script.font = -1;
    return;
  }
  if (isDictionary(code)) {
    script.run++;
    script.cost += (2 * script.run - 1) / DICTIONARY_RUN;
  } else script.run = 0;
  const block = fallbackOf(code);
  if (block >= 0) {
    if (block !== script.font) script.cost += fallbackCost(block);
    script.font = block;
  } else if (script.font >= 0 && !keepsRun(code)) script.font = -1;
}

/** An odd number of backslashes before `index`, on its line after `from`. */
function escapedAt(text: string, index: number, from: number): boolean {
  let escapes = 0;
  while (index - escapes - 1 >= from && text.charCodeAt(index - escapes - 1) === 92) escapes++;
  return escapes % 2 === 1;
}

function isBlank(code: number): boolean {
  return code === 32 || code === 9;
}

function isAsciiLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

const WHITESPACE = /\s/;
const PUNCTUATION = /[\p{P}\p{S}]/u;

/** 0 whitespace, 1 punctuation, 2 other: micromark-util-classify-character, written here. */
function classify(text: string, index: number, start: number, end: number): number {
  if (index < start || index >= end) return 0;
  let code = text.charCodeAt(index);
  let char = text[index];
  // Read a whole code point on either side of a surrogate pair.
  if (code >= 0xdc00 && code <= 0xdfff && index > start) {
    const high = text.charCodeAt(index - 1);
    if (high >= 0xd800 && high <= 0xdbff) {
      char = text.slice(index - 1, index + 1);
      code = -1;
    }
  } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < end) {
    const low = text.charCodeAt(index + 1);
    if (low >= 0xdc00 && low <= 0xdfff) {
      char = text.slice(index, index + 2);
      code = -1;
    }
  }
  if (code !== -1 && code < 128) {
    if (code === 32 || (code >= 9 && code <= 13)) return 0;
    if (
      (code >= 33 && code <= 47) ||
      (code >= 58 && code <= 64) ||
      (code >= 91 && code <= 96) ||
      (code >= 123 && code <= 126)
    )
      return 1;
    return 2;
  }
  if (WHITESPACE.test(char)) return 0;
  if (PUNCTUATION.test(char)) return 1;
  return 2;
}

/** The marks of the runs of * _ ~ paired on one line, from `from` to `end`: once without
 *  regard to pipes, once where a pipe before the closer also undoes the pair. */
function pairedOnLine(text: string, lineStart: number, from: number, end: number): [number, number] {
  let paired = 0;
  let pairedInTable = 0;
  // The first character before which a code span, a tag, a link, an escape (or, in a table, a
  // cell) could hide an opener.
  let firstBlock = end;
  let firstPipe = end;
  // The opener waiting for the next run of its character, by character: its start and length.
  let openStar = -1;
  let openStarLength = 0;
  let openUnder = -1;
  let openUnderLength = 0;
  let openTilde = -1;
  let openTildeLength = 0;
  let i = from;
  while (i < end) {
    const code = text.charCodeAt(i);
    if (code === 96 || code === 60 || code === 91 || code === 93 || code === 92) {
      if (firstBlock === end) firstBlock = i;
      i++;
      continue;
    }
    if (code === 124) {
      if (firstPipe === end) firstPipe = i;
      i++;
      continue;
    }
    if (code !== 42 && code !== 95 && code !== 126) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < end && text.charCodeAt(j) === code) j++;
    const length = j - i;
    const before = classify(text, i - 1, lineStart, end);
    const after = classify(text, j, lineStart, end);
    const mayOpen = after !== 0 && (after !== 1 || before !== 2);
    const mayClose = before !== 0 && (before !== 1 || after !== 2);
    const opener = code === 42 ? openStar : code === 95 ? openUnder : openTilde;
    const openerLength =
      code === 42 ? openStarLength : code === 95 ? openUnderLength : openTildeLength;
    // This run is the next of its character after the waiting opener, whatever it is: the
    // opener pairs with it or with nothing.
    if (opener !== -1 && mayClose && !mayOpen && openerLength === length && firstBlock > i) {
      paired += 2 * length;
      if (firstPipe > i) pairedInTable += 2 * length;
    }
    const next = mayOpen && !mayClose ? i : -1;
    if (code === 42) {
      openStar = next;
      openStarLength = length;
    } else if (code === 95) {
      openUnder = next;
      openUnderLength = length;
    } else {
      openTilde = next;
      openTildeLength = length;
    }
    i = j;
  }
  return [paired, pairedInTable];
}

/** What the Markdown parser will have to go over again, counted in one pass, without parsing.
 *  Lines end at \n, \r\n or \r; a blank is a space or a tab. On each line:
 *  - the prefix is read first: blanks, and container markers for as long as one follows another:
 *    ">" ; "-", "+" or "*" followed by a blank or the end of the line ; 1 to 9 digits then "." or
 *    ")" followed by a blank or the end of the line (these two kinds are list markers);
 *  - containers = the markers of the prefix, plus the list items the line may continue by its
 *    indentation: the lesser of half the blank columns of the prefix (a tab counts 4; rounded
 *    down) and `open`;
 *  - inline = each * _ [ ] ~ ` after the prefix ; pipes = each | after the prefix ; plain = each
 *    < & \ after the prefix;
 *  - paired = the marks of the runs paired on the line. A run is a stretch of one character
 *    among * _ ~ after the prefix. The code point before it and the one after it are each
 *    whitespace (/\s/, or the start or the end of the line), punctuation (/[\p{P}\p{S}]/u) or
 *    other: micromark-util-classify-character, written here, not imported. A run may open when
 *    the one after is not whitespace and, if it is punctuation, the one before is not other; it
 *    may close when the one before is not whitespace and, if it is punctuation, the one after is
 *    not other (micromark's rule for * and _, and for ~ in gfm-strikethrough). An opener (may
 *    open, may not close) and the next run of the same character on the line are a pair when
 *    that run is a closer (may close, may not open) of the same length, and no ` < [ ] or \ comes
 *    before it on the line (a code span, a tag, a link or an escape could hide its opener); the
 *    marks of both runs are paired. A run that is in no pair is not;
 *  - pairedInTable = the same count, where a | before the closer on the line also undoes the
 *    pair (a cell could hide its opener);
 *  - delimiter = after the prefix, the line holds only - : | and blanks, at least one -, and at
 *    least one : or | (a GFM table's delimiter row; a line of - alone is a rule or a heading);
 *  - the line costs 2 × containers² + MARK_COST × (2 × containers + inline + plain + 1).
 *  A line of blanks alone is a blank line: it costs MARK_COST and ends the block. A block (the
 *  lines between two blank lines) holds a table when one of its lines but the first is a
 *  delimiter. In a block that holds a table, its pipes are inline marks: they are added to its
 *  inline marks, cost MARK_COST each, and its paired marks are the sum of pairedInTable; and
 *  each line of the block after its first delimiter line costs MARK_COST × max(0, d − its pipes)
 *  more, d being the most | of a delimiter line of the block read so far: GFM gives every row as
 *  many cells as its delimiter row has, a line without any | included, and these are the cells
 *  the line does not write. In any other block a | is a letter and costs nothing, and its paired
 *  marks are the sum of paired.
 *  Each block then costs (its inline marks + its number of lines)² when one of its lines has
 *  containers > 0, else (its inline marks − its paired marks) × (its inline marks + its number
 *  of lines): under a container the parser goes over every line again; without one, only a mark
 *  that finds no partner on its own line may send it back over the paragraph.
 *  `open` is an upper bound of the list items still open, carried from line to line: 0 at the
 *  start; left as it is by a blank line; on a line that starts the text or follows a blank line,
 *  the items the line continues plus its list markers; on a line that follows another line, the
 *  greater of its value and that number (such a line may go on with a paragraph and close nothing).
 *  Then the HTML openers the parser follows to their end across the paragraph: "<!--" (its end
 *  "-->"), "<?" ("?>"), "<![CDATA[" ("]]>"), and "<!" followed by an ASCII letter (">"), wherever
 *  they are. Each is followed to the first of its ends that starts after the opener's own
 *  characters, or, when none comes first, to the end of its block (where the blank line that
 *  ends it starts, or the end of the text). The distances, from each opener's "<" to the end
 *  found, are added up over the text; a quarter of the sum, rounded up, is added to the cost.
 *  The openers of a kind that wait for their end are kept as a count and a sum of positions,
 *  settled together at an end or at a blank line.
 *  Last, the runs of backticks, wherever they are (a run: one or more ` in a row). Each is
 *  followed to the next run of the same length in its block, from the first ` of the one to the
 *  first ` of the other, or, when none comes, to the end of its block (as for the openers). Twice
 *  the sum of these distances is added to the cost. A run after an odd number of backslashes
 *  (in its line, after its prefix) waits as a run one shorter, from its second `, its first being
 *  escaped; it still settles the runs waiting at its written length, since in a code span a
 *  backslash is a letter. The runs waiting at each length are kept as a count and a sum of
 *  positions, settled together by the next run of that length or at the end of the block:
 *  nothing is read twice.
 *  And the labels. In a block, each "[" (and "![", an image's) waits on a stack; each "]" closes
 *  the last one waiting, which costs its distance in characters divided by LABEL_CHARACTERS, plus
 *  LABEL_BLANK for each space, tab or line break between them, IMAGE_LABEL times as much for an
 *  image's; the sum, rounded up, is added to the cost. The parser serialises and normalises the
 *  whole span at each "]", piece by piece, and a blank makes a piece. A "[" or a "]" after an
 *  odd number of backslashes (on its line, after its prefix) is a letter. Something else may hide
 *  a "[" or a "]" from the parser, or not: a run of backticks still waiting in the block; an HTML
 *  construct or an autolink of the block not yet ended, as micromark ends it (a "<" followed by an
 *  ASCII letter or "/" at the next ">" outside quotes, a quote opening a value that only the same
 *  quote closes; "<!--" at "-->", "<?" at "?>", "<![CDATA[" at "]]>", "<!" and a letter at ">",
 *  each end starting after the opener's own characters); a link's destination or title, from a
 *  "](" to its ")" (outside quotes, its own parentheses balanced). Then the count takes the worst:
 *  a "[" that may be hidden waits on the stack of every "[" only, and a "]" that may be hidden is
 *  read as closing a "[" without taking one off that stack. Each "]" pays for the last "[" nothing
 *  hides that no "]" has closed yet, or, when none is left, for the first "[" still on the stack
 *  of every "[": the parser's own "[" is never further down (a "]" that finds no label makes the
 *  parser go one "[" further down at the next; with 200 "[" hidden in code spans, autolinks, a
 *  tag's attribute, a comment or an image's destination, around tabbed letters, it took a second,
 *  15/11). The stacks empty at the end of a block.
 *  And the link titles opened by a parenthesis. In a block, once "](" has been read in it,
 *  every "(" that follows a blank, or that is the first character of a line after its prefix,
 *  may open a title (micromark opens one only after a destination and a blank, and looks for its
 *  ")" across the paragraph without stopping at another "("). Each is followed to the first ")"
 *  after it that does not follow a "\", or, when none comes, to the end of its block (as for
 *  the openers). Half the sum of these distances, rounded up, is added to the cost. The
 *  openers waiting are kept as a count and a sum of positions, settled together at such a ")"
 *  or at a blank line. */
export function layoutCost(text: string): number {
  const length = text.length;
  let cost = 0;
  let open = 0;
  let afterBlank = true;

  // The block being read.
  let blockLines = 0;
  let blockInline = 0;
  let blockPipes = 0;
  let blockPaired = 0;
  let blockPairedInTable = 0;
  let blockContainers = false;
  let blockTable = false;
  let blockDelimiterPipes = 0;
  let blockMissingCells = 0;
  let blockLinkSeen = false;
  // What the browser's layout pays beyond the parsers: the characters of other scripts than the
  // simplest in the block, and the changes of direction and dictionary runs of every line.
  let blockScript = 0;
  let scriptCost = 0;
  const script = newScript();

  // The HTML openers waiting for their end, by kind.
  const waitingCount = [0, 0, 0, 0];
  const waitingSum = [0, 0, 0, 0];
  const waitingLast = [0, 0, 0, 0];
  let openerDistance = 0;

  // The runs of backticks waiting, by length: how many, and the sum of their positions.
  let ticks = new Map<number, { count: number; sum: number }>();
  let tickDistance = 0;

  // The "[" of the block, innermost last: where each is, the blanks read before it, and whether it
  // opens an image. `labels`: every "[" not escaped, which only a "]" nothing may hide closes.
  // `shown`: only those nothing may hide, which every "]" not escaped closes. Whatever the parser
  // takes or leaves of what may be hidden, its own stack holds `shown` and lies within `labels`
  // (each read the same way): the "[" a "]" closes is never further down than the top of `shown`,
  // nor than the bottom of `labels`.
  let labels: Label[] = [];
  let shown: Label[] = [];
  let blanks = 0;
  let labelCost = 0;
  const spanCost = (label: Label, at: number) => {
    const span = (at - label.at) / LABEL_CHARACTERS + (blanks - label.blanks) * LABEL_BLANK;
    return label.image ? IMAGE_LABEL * span : span;
  };
  // The HTML construct or autolink of the block not yet ended, where its "<" is, and the quote
  // of the attribute value it is in (0 when none): it may hide a "[".
  let angle = Angle.None;
  let angleAt = 0;
  let angleQuote = 0;
  // A link's destination or title, from its "](" to its ")": where its "(" is, its parentheses
  // still open, and the quote of its title (0 when none), or -1 when none is open.
  let resourceAt = -1;
  let resourceDepth = 0;
  let resourceQuote = 0;
  const mayHide = () => ticks.size > 0 || angle !== Angle.None || resourceAt >= 0;

  // The link titles waiting for their ")".
  let titleCount = 0;
  let titleSum = 0;
  let titleDistance = 0;

  const endBlock = (at: number) => {
    if (blockLines > 0) {
      const inline = blockTable ? blockInline + blockPipes : blockInline;
      const paired = blockTable ? blockPairedInTable : blockPaired;
      if (blockTable) cost += MARK_COST * blockPipes + blockMissingCells;
      cost += blockContainers
        ? (inline + blockLines) * (inline + blockLines)
        : (inline - paired) * (inline + blockLines);
    }
    blockLines = 0;
    blockInline = 0;
    blockPipes = 0;
    blockPaired = 0;
    blockPairedInTable = 0;
    blockContainers = false;
    blockTable = false;
    blockDelimiterPipes = 0;
    blockMissingCells = 0;
    blockLinkSeen = false;
    scriptCost += (blockScript * blockScript) / SCRIPT_BLOCK;
    blockScript = 0;
    for (let kind = 0; kind < 4; kind++) {
      openerDistance += waitingCount[kind] * at - waitingSum[kind];
      waitingCount[kind] = 0;
      waitingSum[kind] = 0;
    }
    if (ticks.size > 0) {
      for (const { count, sum } of ticks.values()) tickDistance += count * at - sum;
      ticks = new Map();
    }
    labels = [];
    shown = [];
    angle = Angle.None;
    angleQuote = 0;
    resourceAt = -1;
    titleDistance += titleCount * at - titleSum;
    titleCount = 0;
    titleSum = 0;
  };

  const settle = (kind: number, at: number) => {
    const count = waitingCount[kind];
    if (count === 0) return;
    const end = at + END_LENGTH[kind];
    // An end that starts inside the last opener's own characters does not close that one.
    if (waitingLast[kind] + OPENER_LENGTH[kind] > at) {
      const last = waitingLast[kind];
      openerDistance += (count - 1) * end - (waitingSum[kind] - last);
      waitingCount[kind] = 1;
      waitingSum[kind] = last;
    } else {
      openerDistance += count * end - waitingSum[kind];
      waitingCount[kind] = 0;
      waitingSum[kind] = 0;
    }
  };

  // A line ending at the very end of the text opens no further line.
  let lineStart = 0;
  while (lineStart < length) {
    let lineEnd = lineStart;
    while (lineEnd < length) {
      const code = text.charCodeAt(lineEnd);
      if (code === 10 || code === 13) break;
      lineEnd++;
    }
    let next = lineEnd;
    if (next < length) next += text.charCodeAt(next) === 13 && text.charCodeAt(next + 1) === 10 ? 2 : 1;

    // The prefix.
    let i = lineStart;
    let columns = 0;
    let markers = 0;
    let listMarkers = 0;
    for (;;) {
      while (i < lineEnd && isBlank(text.charCodeAt(i))) {
        columns += text.charCodeAt(i) === 9 ? 4 : 1;
        i++;
      }
      if (i >= lineEnd) break;
      const code = text.charCodeAt(i);
      if (code === 62) {
        markers++;
        i++;
        continue;
      }
      if (code === 45 || code === 43 || code === 42) {
        if (i + 1 >= lineEnd || isBlank(text.charCodeAt(i + 1))) {
          markers++;
          listMarkers++;
          i++;
          continue;
        }
        break;
      }
      if (code >= 48 && code <= 57) {
        let j = i;
        while (j < lineEnd && j - i < 10) {
          const digit = text.charCodeAt(j);
          if (digit < 48 || digit > 57) break;
          j++;
        }
        const digits = j - i;
        const mark = j < lineEnd ? text.charCodeAt(j) : 0;
        if (
          digits <= 9 &&
          (mark === 46 || mark === 41) &&
          (j + 1 >= lineEnd || isBlank(text.charCodeAt(j + 1)))
        ) {
          markers++;
          listMarkers++;
          i = j + 1;
          continue;
        }
      }
      break;
    }
    const prefixEnd = i;

    if (prefixEnd >= lineEnd && markers === 0) {
      // A blank line: it ends the block; `open` is left as it is.
      cost += MARK_COST;
      endBlock(lineStart);
      afterBlank = true;
      lineStart = next;
      continue;
    }

    // The line break before this line, read by a label that spans it.
    blanks++;
    startLine(script);
    const continued = Math.min(Math.floor(columns / 2), open);
    const containers = markers + continued;
    const items = continued + listMarkers;
    open = afterBlank ? items : Math.max(open, items);
    afterBlank = false;

    let inline = 0;
    let plain = 0;
    let pipes = 0;
    let onlyDelimiter = true;
    let dashes = 0;
    let colonsOrPipes = 0;
    for (let k = prefixEnd; k < lineEnd; k++) {
      const code = text.charCodeAt(k);
      switch (code) {
        case 42: // *
        case 95: // _
        case 91: // [
        case 93: // ]
        case 126: // ~
          inline++;
          onlyDelimiter = false;
          break;
        case 96: // `
          inline++;
          onlyDelimiter = false;
          break;
        case 60: // <
        case 38: // &
        case 92: // \
          plain++;
          onlyDelimiter = false;
          break;
        case 124: // |
          pipes++;
          colonsOrPipes++;
          break;
        case 45: // -
          dashes++;
          break;
        case 58: // :
          colonsOrPipes++;
          break;
        case 32:
        case 9:
          break;
        default:
          onlyDelimiter = false;
      }

      readScriptAt(script, text, k, code);
      if (code >= 0x0590) blockScript++;

      // What may hide a "[" from the parser: an HTML construct or an autolink not yet ended, a
      // link's destination or title not yet closed.
      if (angle === Angle.Tag) {
        if (angleQuote !== 0) {
          if (code === angleQuote) angleQuote = 0;
        } else if (code === 39 || code === 34) angleQuote = code;
        // A "<" ends the tag it cannot be part of, and may open another, read below.
        else if (code === 62 || code === 60) angle = Angle.None;
      } else if (angle === Angle.Comment) {
        if (code === 45 && k >= angleAt + 4 && text.startsWith("-->", k)) angle = Angle.None;
      } else if (angle === Angle.Instruction) {
        if (code === 63 && k >= angleAt + 2 && text.charCodeAt(k + 1) === 62) angle = Angle.None;
      } else if (angle === Angle.Cdata) {
        if (code === 93 && k >= angleAt + 9 && text.startsWith("]]>", k)) angle = Angle.None;
      } else if (angle === Angle.Declaration) {
        if (code === 62) angle = Angle.None;
      }
      if (angle === Angle.None && code === 60) {
        const after = text.charCodeAt(k + 1);
        if (text.startsWith("<!--", k)) angle = Angle.Comment;
        else if (after === 63) angle = Angle.Instruction;
        else if (text.startsWith("<![CDATA[", k)) angle = Angle.Cdata;
        else if (after === 33 && isAsciiLetter(text.charCodeAt(k + 2))) angle = Angle.Declaration;
        else if (isAsciiLetter(after) || after === 47) angle = Angle.Tag;
        angleAt = k;
        angleQuote = 0;
      }
      if (resourceAt >= 0 && k > resourceAt && text.charCodeAt(k - 1) !== 92) {
        if (resourceQuote !== 0) {
          if (code === resourceQuote) resourceQuote = 0;
        } else if (code === 39 || code === 34) resourceQuote = code;
        else if (code === 40) resourceDepth++;
        else if (code === 41) {
          if (resourceDepth > 0) resourceDepth--;
          else resourceAt = -1;
        }
      }

      // The HTML openers and their ends.
      if (code === 60) {
        if (text.startsWith("<!--", k)) {
          waitingCount[Kind.Comment]++;
          waitingSum[Kind.Comment] += k;
          waitingLast[Kind.Comment] = k;
        } else if (text.charCodeAt(k + 1) === 63) {
          waitingCount[Kind.Instruction]++;
          waitingSum[Kind.Instruction] += k;
          waitingLast[Kind.Instruction] = k;
        } else if (text.startsWith("<![CDATA[", k)) {
          waitingCount[Kind.Cdata]++;
          waitingSum[Kind.Cdata] += k;
          waitingLast[Kind.Cdata] = k;
        } else if (text.charCodeAt(k + 1) === 33 && isAsciiLetter(text.charCodeAt(k + 2))) {
          waitingCount[Kind.Declaration]++;
          waitingSum[Kind.Declaration] += k;
          waitingLast[Kind.Declaration] = k;
        }
      } else if (code === 45) {
        if (text.startsWith("-->", k)) settle(Kind.Comment, k);
      } else if (code === 63) {
        if (text.charCodeAt(k + 1) === 62) settle(Kind.Instruction, k);
      } else if (code === 93) {
        if (text.startsWith("]]>", k)) settle(Kind.Cdata, k);
        if (text.charCodeAt(k + 1) === 40) {
          blockLinkSeen = true;
          resourceAt = k + 1;
          resourceDepth = 0;
          resourceQuote = 0;
        }
        if (!escapedAt(text, k, prefixEnd)) {
          const label = shown.pop() ?? labels[0];
          if (label !== undefined) labelCost += spanCost(label, k);
          if (!mayHide()) labels.pop();
        }
      } else if (code === 91) {
        if (!escapedAt(text, k, prefixEnd)) {
          const label: Label = { at: k, blanks, image: k > 0 && text.charCodeAt(k - 1) === 33 };
          labels.push(label);
          if (!mayHide()) shown.push(label);
        }
      } else if (code === 32 || code === 9) {
        blanks++;
      } else if (code === 62) {
        settle(Kind.Declaration, k);
      } else if (code === 96) {
        let j = k + 1;
        while (j < lineEnd && text.charCodeAt(j) === 96) j++;
        const run = j - k;
        // A run closes the open runs of its length as written: inside a code span a backslash
        // is a letter. It opens one shorter after an odd number of backslashes, the first
        // backtick escaped; then several runs of one length may wait together.
        const closed = ticks.get(run);
        if (closed !== undefined) {
          tickDistance += closed.count * k - closed.sum;
          ticks.delete(run);
        }
        let escapes = 0;
        while (k - escapes - 1 >= prefixEnd && text.charCodeAt(k - escapes - 1) === 92) escapes++;
        const opens = escapes % 2 === 1 ? run - 1 : run;
        const start = escapes % 2 === 1 ? k + 1 : k;
        if (opens > 0) {
          const waiting = ticks.get(opens);
          if (waiting) {
            waiting.count++;
            waiting.sum += start;
          } else ticks.set(opens, { count: 1, sum: start });
        }
        inline += run - 1;
        k = j - 1;
      } else if (code === 40) {
        if (blockLinkSeen && (k === prefixEnd || isBlank(text.charCodeAt(k - 1)))) {
          titleCount++;
          titleSum += k;
        }
      } else if (code === 41) {
        if (titleCount > 0 && text.charCodeAt(k - 1) !== 92) {
          titleDistance += titleCount * k - titleSum;
          titleCount = 0;
          titleSum = 0;
        }
      }
    }

    const delimiter = onlyDelimiter && dashes > 0 && colonsOrPipes > 0;
    const [paired, pairedInTable] =
      inline > 0 ? pairedOnLine(text, lineStart, prefixEnd, lineEnd) : [0, 0];

    cost += 2 * containers * containers + MARK_COST * (2 * containers + inline + plain + 1);

    if (blockTable) blockMissingCells += MARK_COST * Math.max(0, blockDelimiterPipes - pipes);
    if (delimiter && blockLines > 0) {
      blockTable = true;
      blockDelimiterPipes = Math.max(blockDelimiterPipes, pipes);
    }
    blockLines++;
    blockInline += inline;
    blockPipes += pipes;
    blockPaired += paired;
    blockPairedInTable += pairedInTable;
    if (containers > 0) blockContainers = true;

    lineStart = next;
  }
  endBlock(length);

  return (
    cost +
    Math.ceil(openerDistance / 4) +
    2 * tickDistance +
    Math.ceil(titleDistance / 2) +
    Math.ceil(labelCost) +
    Math.ceil(scriptCost + script.cost)
  );
}

/** Why a text is not laid out, read before any parsing: "tooLong" when `length` passes
 *  LAYOUT_BOUND, else "tooDense" when layoutCost(text) passes LAYOUT_COST_BOUND, else null.
 *  `length`: text.length for a message, layoutLength(text) for a presentation. */
export function layoutRefusal(
  text: string,
  length: number = text.length,
): "tooLong" | "tooDense" | null {
  if (length > LAYOUT_BOUND) return "tooLong";
  if (layoutCost(text) > LAYOUT_COST_BOUND) return "tooDense";
  return null;
}

const MARK = /\p{M}/u;

/** Where a part may end at or before `position`: never between the two halves of a surrogate
 *  pair, nor before a mark or a joiner that belongs to the character before it (a few steps back
 *  at most, so that the part still ends). */
function cutAt(text: string, position: number): number {
  let at = position;
  for (let steps = 0; at > 0 && at < text.length && steps < 32; steps++) {
    const code = text.charCodeAt(at);
    const before = text.charCodeAt(at - 1);
    const splitsPair = code >= 0xdc00 && code <= 0xdfff && before >= 0xd800 && before <= 0xdbff;
    if (!splitsPair && code !== 0x200d && !(code >= 0xfe00 && code <= 0xfe0f) && !MARK.test(text[at])) break;
    at--;
  }
  return at > 0 ? at : position;
}

/** Where each part of a text shown without layout starts, in one walk over the text: a part ends
 *  at PLAIN_PART UTF-16 units, or sooner, once what the browser's layout pays for it reaches
 *  LAYOUT_COST_BOUND (the square of each line's characters of other scripts than the simplest,
 *  over PLAIN_SCRIPT_LINE; the changes of direction; the dictionary runs), and never inside a
 *  character. A text of PLAIN_PART or less that costs less is one part. */
export function plainCuts(text: string): number[] {
  const cuts = [0];
  let start = 0;
  let line = 0;
  let cost = 0;
  const script = newScript();
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 10 || code === 13) {
      line = 0;
      startLine(script);
      continue;
    }
    readScriptAt(script, text, i, code);
    if (code >= 0x0590) {
      line++;
      cost += (2 * line - 1) / PLAIN_SCRIPT_LINE;
    }
    if (i + 1 - start >= PLAIN_PART || cost + script.cost > LAYOUT_COST_BOUND) {
      let cut = cutAt(text, i + 1);
      if (cut <= start) cut = i + 1;
      if (cut >= text.length) break;
      cuts.push(cut);
      start = cut;
      // The characters a cut moved back over are read again, in the next part.
      i = cut - 1;
      line = 0;
      cost = 0;
      Object.assign(script, newScript());
    }
  }
  return cuts;
}

/** Part `index` (from 0, clamped to the last) of a text shown without layout, and how many parts
 *  there are, by the starts plainCuts found (found again when not given). */
export function plainPart(text: string, index: number, cuts: number[] = plainCuts(text)): { part: string; count: number } {
  const count = cuts.length;
  const i = Math.min(Math.max(0, Math.floor(index)), count - 1);
  const end = i === count - 1 ? text.length : cuts[i + 1];
  return { part: i === 0 && count === 1 ? text : text.slice(cuts[i], end), count };
}
