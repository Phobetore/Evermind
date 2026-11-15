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
 *  whole span at each "]", piece by piece, and a blank makes a piece. The stack empties at the
 *  end of a block.
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

  // The HTML openers waiting for their end, by kind.
  const waitingCount = [0, 0, 0, 0];
  const waitingSum = [0, 0, 0, 0];
  const waitingLast = [0, 0, 0, 0];
  let openerDistance = 0;

  // The runs of backticks waiting, by length: how many, and the sum of their positions.
  let ticks = new Map<number, { count: number; sum: number }>();
  let tickDistance = 0;

  // The "[" still open in the block, innermost last: where each is, the blanks read before it,
  // and whether it opens an image.
  let labels: Array<{ at: number; blanks: number; image: boolean }> = [];
  let blanks = 0;
  let labelCost = 0;

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
        if (text.charCodeAt(k + 1) === 40) blockLinkSeen = true;
        const label = labels.pop();
        if (label !== undefined) {
          const cost = (k - label.at) / LABEL_CHARACTERS + (blanks - label.blanks) * LABEL_BLANK;
          labelCost += label.image ? IMAGE_LABEL * cost : cost;
        }
      } else if (code === 91) {
        labels.push({ at: k, blanks, image: k > 0 && text.charCodeAt(k - 1) === 33 });
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
    Math.ceil(labelCost)
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

function cutAt(text: string, position: number): number {
  if (position <= 0 || position >= text.length) return position;
  const high = text.charCodeAt(position - 1);
  const low = text.charCodeAt(position);
  // Never between the two halves of a surrogate pair.
  return high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff
    ? position - 1
    : position;
}

/** Part `index` (from 0, clamped to the last) of a text shown without layout, and how many parts
 *  there are: cut every PLAIN_PART UTF-16 units, one unit earlier when the cut would fall between
 *  the two halves of a surrogate pair. Each cut is found from its own position, without walking
 *  the text: the time does not grow with the number of parts. A text of PLAIN_PART or less is one
 *  part, itself. */
export function plainPart(text: string, index: number): { part: string; count: number } {
  const count = Math.max(1, Math.ceil(text.length / PLAIN_PART));
  if (count === 1) return { part: text, count };
  const i = Math.min(Math.max(0, Math.floor(index)), count - 1);
  const start = i === 0 ? 0 : cutAt(text, i * PLAIN_PART);
  const end = i === count - 1 ? text.length : cutAt(text, (i + 1) * PLAIN_PART);
  return { part: text.slice(start, end), count };
}
