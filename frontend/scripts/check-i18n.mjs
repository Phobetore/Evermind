// Fails when the locale files drift apart. English is the reference: it is the
// language the interface is written in, so a key it lacks is a key nobody asked
// for, and a key it has that others lack is a string somebody will read in the
// wrong language.
//
//   node scripts/check-i18n.mjs
//
// Also reports empty values, since a key present with an empty string renders as
// nothing at all and is harder to notice than a missing key.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = new URL("../src/i18n/locales/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const REFERENCE = "en";

const flatten = (obj, prefix = "") =>
  Object.entries(obj).flatMap(([key, value]) =>
    value && typeof value === "object"
      ? flatten(value, `${prefix}${key}.`)
      : [[`${prefix}${key}`, value]],
  );

const locales = {};
for (const file of readdirSync(DIR).filter((f) => f.endsWith(".json"))) {
  const name = file.replace(/\.json$/, "");
  locales[name] = new Map(flatten(JSON.parse(readFileSync(join(DIR, file), "utf8"))));
}

if (!locales[REFERENCE]) {
  console.error(`No ${REFERENCE}.json to compare against.`);
  process.exit(1);
}

const reference = locales[REFERENCE];
let failed = false;

for (const [name, entries] of Object.entries(locales)) {
  const missing = [...reference.keys()].filter((k) => !entries.has(k));
  const unknown = [...entries.keys()].filter((k) => !reference.has(k));
  const empty = [...entries].filter(([, v]) => typeof v === "string" && v.trim() === "").map(([k]) => k);

  if (!missing.length && !unknown.length && !empty.length) {
    console.log(`  ${name}: ${entries.size} keys, matches ${REFERENCE}`);
    continue;
  }

  failed = true;
  console.log(`  ${name}: ${entries.size} keys`);
  for (const [label, list] of [
    ["missing", missing],
    [`not in ${REFERENCE}`, unknown],
    ["empty", empty],
  ]) {
    if (list.length) {
      console.log(`    ${list.length} ${label}: ${list.slice(0, 10).join(", ")}${list.length > 10 ? ", ..." : ""}`);
    }
  }
}

process.exit(failed ? 1 : 0);
