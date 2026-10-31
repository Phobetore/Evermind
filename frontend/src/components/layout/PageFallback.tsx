import { useT } from "@/i18n/useT";
import { useEffect, useState } from "react";

/** How long a page may take to arrive before the person is told it is coming.
 *  Over a home network the file is there before this is up, and a line that
 *  appears and vanishes within a few frames is worse than none. */
const GRACE_MS = 200;

/** Shown while the code of a page is being fetched. Says nothing at first;
 *  then the same line, in the same look, that the pages use while their data
 *  is on its way. */
export function PageFallback() {
  const t = useT();
  const [late, setLate] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setLate(true), GRACE_MS);
    return () => clearTimeout(timer);
  }, []);
  if (!late) return null;
  return <div className="p-10 text-mist animate-pulse-soft">{t("common.loading")}</div>;
}
