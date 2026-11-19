// Download the free DB-IP "IP to City Lite" database (CC BY 4.0, https://db-ip.com) for visitor locations.
// Usage: node scripts/download-geoip.mjs [--if-missing]     (writes GEOIP_DB, default data/geoip.mmdb)
// DB-IP publishes a new file every month; re-run monthly (the Docker image does this on start when the file is >40 days old).
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';

const out = process.env.GEOIP_DB ?? 'data/geoip.mmdb';
const MAX_AGE_DAYS = 40;

if (process.argv.includes('--if-missing') && existsSync(out)) {
  const ageDays = (Date.now() - statSync(out).mtimeMs) / 86_400_000;
  if (ageDays < MAX_AGE_DAYS) process.exit(0);
  console.log(`GeoIP database is ${Math.round(ageDays)} days old, updating`);
}

const month = (offset) => {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - offset);
  return d.toISOString().slice(0, 7);
};

mkdirSync(dirname(out), { recursive: true });
for (const m of [month(0), month(1)]) {
  const url = `https://download.db-ip.com/free/dbip-city-lite-${m}.mmdb.gz`;
  const res = await fetch(url).catch(() => null);
  if (!res?.ok || !res.body) continue;
  console.log(`Downloading ${url}`);
  const tmp = out + '.tmp';
  await pipeline(Readable.fromWeb(res.body), createGunzip(), createWriteStream(tmp));
  renameSync(tmp, out);
  console.log(`Saved ${out} (${Math.round(statSync(out).size / 1e6)} MB). IP geolocation by DB-IP.com`);
  process.exit(0);
}
console.error('Could not download the GeoIP database; visitor locations will be missing. GI Tracker still works.');
// Don't fail the container start over this.
process.exit(0);
