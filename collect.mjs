// Builds emotes.json (all-time emote counts) for index.html.
// Usage: node collect.mjs            (Node 18+, no dependencies)
//        node collect.mjs --refresh  (re-query emotes that already have a count)
//
// !! UNVERIFIED: I could not inspect RustleSearch's real API from here.
// !! Open https://rustlesearch.dev, search for an emote, then check
// !! DevTools > Network. Copy the request URL/params into searchUrl() and
// !! point readCount() at the "total results" number in the JSON response.
// !! Also check whether the total counts messages containing the emote
// !! (likely) or every occurrence; the site will then show that number.

import { readFile, writeFile } from "node:fs/promises";

const CHANNEL = "Destinygg";
const WIKI_PAGES = [ // used only to find emote images; current pages first so current art wins
  "https://wiki.destiny.gg/view/Current_Emotes_(A-L)",
  "https://wiki.destiny.gg/view/Current_Emotes_(M-Z)",
  "https://wiki.destiny.gg/view/Past_Emotes",
];
const DELAY_MS = 1500; // be gentle: this is a hobby service with rate limiting
const OUT = "emotes.json";

// ---- ADJUST THESE TWO AFTER CHECKING THE NETWORK TAB ----
const searchUrl = (emote) =>
  "https://api-v2.rustlesearch.dev/anon/search?" +
  new URLSearchParams({ text: emote, channel: CHANNEL });
const readCount = (json) => json?.data?.total ?? json?.total ?? null;
// ----------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const refresh = process.argv.includes("--refresh");

const prev = new Map();
try {
  for (const e of JSON.parse(await readFile(OUT, "utf8")).emotes) prev.set(e.name, e);
} catch {} // first run

// Logs are plain text, so the emote list is yours: emotes.txt, one per line.
// Format: NAME   or   NAME,https://image-url   (lines starting with # are ignored)
const manual = (await readFile("emotes.txt", "utf8"))
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith("#"))
  .map((l) => {
    const ambiguous = l.startsWith("~"); // also an everyday word, counts will be inflated
    const [name, image] = l.replace(/^~/, "").split(",").map((s) => s.trim());
    return { name, image: image || null, ambiguous };
  });

// Fill in missing images from the wiki's emote tables. Unverified: this assumes
// each emote is a table row with its name as the first link and its image on
// wikicdn.destiny.gg. If it finds nothing, emotes just show as text.
const wikiImg = new Map();
for (const url of WIKI_PAGES) {
  try {
    const html = await (await fetch(url)).text();
    for (const row of html.split(/<tr[\s>]/i).slice(1)) {
      const name = row.match(/<a [^>]*>([^<]+)<\/a>/)?.[1]?.trim().toLowerCase();
      const img = row.match(/https:\/\/wikicdn\.destiny\.gg\/[^"'\s)]+/)?.[0];
      if (name && img && !wikiImg.has(name)) wikiImg.set(name, img);
    }
  } catch {
    console.warn(`Couldn’t read ${url}; continuing without its images.`);
  }
}
for (const e of manual) e.image ??= wikiImg.get(e.name.toLowerCase()) ?? null;
console.log(`Matched images for ${manual.filter((e) => e.image).length}/${manual.length} emotes`);

const seen = new Set();
const emotes = manual.filter((e) => !seen.has(e.name) && seen.add(e.name));

async function countFor(name) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(searchUrl(name));
    if (res.status === 429) { await sleep(5000 * (attempt + 1)); continue; }
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
    const json = await res.json().catch(() => null);
    const n = readCount(json);
    if (typeof n !== "number") {
      throw new Error(
        `${name}: couldn’t find a count in RustleSearch’s reply.\n` +
        `Request: ${searchUrl(name)}\n` +
        `Reply started: ${json === null ? "(not JSON)" : JSON.stringify(json).slice(0, 600)}\n` +
        `Adjust searchUrl() and readCount() at the top of collect.mjs, then run it again.`
      );
    }
    return n;
  }
  throw new Error(`${name}: still rate limited, try again later`);
}

const results = [];
const save = async () => {
  if (!results.length) return; // never replace emotes.json with an empty list
  await writeFile(OUT, JSON.stringify({
    updated: new Date().toISOString(),
    channel: CHANNEL,
    emotes: [...results].sort((a, b) => b.count - a.count),
  }, null, 1));
};

try {
  for (const [i, e] of emotes.entries()) {
    let count = prev.get(e.name)?.count;
    if (count == null || refresh) {
      count = await countFor(e.name);
      if (i === 0) console.log(`First result: ${e.name} = ${count.toLocaleString()} (check this looks right)`);
      await sleep(DELAY_MS);
    }
    results.push({ ...e, count });
    if (i % 25 === 0) { await save(); console.log(`${i + 1}/${emotes.length}`); }
  }
} catch (err) {
  console.error("\n" + err.message);
  process.exitCode = 1;
} finally {
  await save(); // keep progress even if something fails midway
}
if (!process.exitCode) console.log(`Wrote ${results.length} emotes to ${OUT}`);
