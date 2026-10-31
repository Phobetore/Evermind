import { useEffect, useState } from "react";

/** Shows its children once `ms` have passed since it appeared, and nothing
 *  before. For what tells someone to wait: over a fast connection the wait is
 *  over within a few frames, and a line that appears and vanishes in that time
 *  is worse than none. */
export function Delayed({ ms = 200, children }: { ms?: number; children: React.ReactNode }) {
  const [late, setLate] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setLate(true), ms);
    return () => clearTimeout(timer);
  }, [ms]);
  return late ? children : null;
}
