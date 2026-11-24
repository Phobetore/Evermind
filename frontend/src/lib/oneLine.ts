/** What ends a cut text and would be left hanging before its ellipsis. */
const HANGING = /[\s.…,;:!?(\[{*_\-–—/]+$/u;

/**
 * The longest start of `text` that `fits` on one line, said to go on by an ellipsis: a textarea's
 * placeholder takes no text-overflow, so its cut is drawn here. Cut where the room ends, as the
 * browser's own ellipsis is, so that a long name keeps what it can; a character is never split in two.
 */
export function oneLine(text: string, fits: (line: string) => boolean): string {
  if (fits(text)) return text;
  const chars = [...text];
  const cut = (end: number) => `${chars.slice(0, end).join("").replace(HANGING, "")}…`;
  // What is kept never shortens as `end` grows, so the longest that fits is found by halves.
  let low = 0;
  let high = chars.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(cut(middle))) low = middle;
    else high = middle - 1;
  }
  return cut(low);
}
