const LATEST = "https://api.github.com/repos/Phobetore/Evermind/releases/latest";
const PLAIN = /^\d+(\.\d+)*$/;

export interface Release {
  /** Without the "v" of its tag. */
  version: string;
  url: string | null;
}

/** The newest release, asked of GitHub by the browser, with no cookie and no referrer. */
export async function latestRelease(): Promise<Release> {
  const response = await fetch(LATEST, { credentials: "omit", referrerPolicy: "no-referrer" });
  if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
  const { tag_name, html_url } = await response.json();
  return {
    version: typeof tag_name === "string" ? tag_name.replace(/^v/i, "") : "",
    url: typeof html_url === "string" ? html_url : null,
  };
}

/** Whether `candidate` is a release newer than `current`. A tag that is not plain
 *  numbers, such as `3.1.0-rc1`, never is: nobody is sent to what was not released. */
export function isNewer(candidate: string, current: string): boolean {
  return PLAIN.test(candidate) && PLAIN.test(current)
    && candidate.localeCompare(current, "en", { numeric: true }) > 0;
}
