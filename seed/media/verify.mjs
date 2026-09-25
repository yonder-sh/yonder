#!/usr/bin/env node
// Checks seed/media/manifest.json: files exist, hashes match, fields are valid, and (when the sheet export in
// ../data is present) every entry points at a real Places row (level "place") or City (level "city").
// Usage: node seed/media/verify.mjs      (Node >= 18, no dependencies)
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
const errors = [];
const err = (i, msg) => errors.push(`#${i} ${manifest[i]?.file ?? ""}: ${msg}`);

let places = null;
let cities = null;
const dataDir = join(dir, "..", "data");
if (existsSync(join(dataDir, "places.json"))) {
  places = JSON.parse(readFileSync(join(dataDir, "places.json"), "utf8")).rows;
}
if (existsSync(join(dataDir, "cities.json"))) {
  cities = JSON.parse(readFileSync(join(dataDir, "cities.json"), "utf8")).rows;
}

const seen = new Set();
manifest.forEach((e, i) => {
  for (const k of ["file", "city", "country", "level", "source", "sourceUrl", "pageUrl"]) {
    if (typeof e[k] !== "string" || !e[k]) err(i, `missing ${k}`);
  }
  if (!["place", "city"].includes(e.level)) err(i, `bad level ${e.level}`);
  if (!["wikimedia", "web"].includes(e.source)) err(i, `bad source ${e.source}`);
  if (e.level === "place" && !e.placeName) err(i, "place entry without placeName");
  if (e.level === "city" && e.placeName !== null) err(i, "city entry should have placeName null");
  if (e.source === "wikimedia" && (!e.author || !e.license)) err(i, "wikimedia entry without author/license");
  if (seen.has(e.file)) err(i, "duplicate file");
  seen.add(e.file);
  const p = join(dir, e.file);
  if (!existsSync(p)) return err(i, "file missing");
  const buf = readFileSync(p);
  if (e.bytes !== undefined && buf.length !== e.bytes) err(i, `size ${buf.length} != ${e.bytes}`);
  if (e.sha256 && createHash("sha256").update(buf).digest("hex") !== e.sha256) err(i, "sha256 mismatch");
  if (places && e.level === "place") {
    const hit = places.some((r) => r.Country === e.country && r.City === e.city && r.Place === e.placeName);
    if (!hit) err(i, `no Places row ${e.country} > ${e.city} > ${e.placeName}`);
  }
  if (places && cities && e.level === "city") {
    const hit =
      cities.some((r) => r.Country === e.country && r.City === e.city) ||
      places.some((r) => r.Country === e.country && r.City === e.city);
    if (!hit) err(i, `no City ${e.country} > ${e.city}`);
  }
});

const known = new Set(["manifest.json", "unmatched.json", "verify.mjs", "unmatched"]);
for (const f of readdirSync(dir)) {
  if (!known.has(f) && !seen.has(f) && statSync(join(dir, f)).isFile()) errors.push(`stray file not in manifest: ${f}`);
}

const count = (pred) => manifest.filter(pred).length;
console.log(
  `manifest: ${manifest.length} entries (${count((e) => e.level === "city")} city, ${count((e) => e.level === "place")} place; ` +
    `${count((e) => e.source === "wikimedia")} wikimedia, ${count((e) => e.source === "web")} web)` +
    (places ? "; checked against seed/data" : "; seed/data not found, sheet match skipped"),
);
if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log("OK");
