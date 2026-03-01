/** RP content parser — splits text into speech, actions, and context segments. */

export type RPSegmentType = "speech" | "action" | "context";

export interface RPSegment {
  type: RPSegmentType;
  text: string;
}

/**
 * Parse RP-formatted text into typed segments.
 *
 * - `*text*` → action
 * - `[text]` → context
 * - Everything else → speech
 */
export function parseRPContent(content: string): RPSegment[] {
  const segments: RPSegment[] = [];
  // Match *action* or [context] segments
  const regex = /(\*[^*]+\*)|(\[[^\]]+\])/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(content)) !== null) {
    // Add any speech text before this match
    if (match.index > lastIndex) {
      segments.push({ type: "speech", text: content.slice(lastIndex, match.index) });
    }

    if (match[1]) {
      // *action* — strip the asterisks
      segments.push({ type: "action", text: match[1].slice(1, -1) });
    } else if (match[2]) {
      // [context] — strip the brackets
      segments.push({ type: "context", text: match[2].slice(1, -1) });
    }

    lastIndex = regex.lastIndex;
  }

  // Add any remaining speech text
  if (lastIndex < content.length) {
    segments.push({ type: "speech", text: content.slice(lastIndex) });
  }

  return segments;
}
