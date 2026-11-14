/** A question put to the person, and how its answer is given back. */
export type Asked<O> = O & { question: string; settle: (answer: boolean) => void };

/** One question open at a time, kept outside React so that what it holds is read at once, not
 *  through state: two clicks in the same frame must not open two questions. `show` is told the
 *  question to put on screen, or null once there is none. */
export function oneQuestion<O extends object>(show: (asked: Asked<O> | null) => void) {
  let current: Asked<O> | null = null;
  return {
    /** Settles with the answer; a question asked while another is open is a no at once. */
    ask: (question: string, options: O): Promise<boolean> => {
      if (current) return Promise.resolve(false);
      return new Promise<boolean>((resolve) => {
        const next: Asked<O> = {
          question,
          ...options,
          settle: (answer) => {
            // Answered or dropped already: an answer that comes late must not close a question asked since.
            if (current !== next) return;
            current = null;
            show(null);
            resolve(answer);
          },
        };
        current = next;
        show(next);
      });
    },
    /** The open question, if any, answered no. */
    drop: () => current?.settle(false),
  };
}
