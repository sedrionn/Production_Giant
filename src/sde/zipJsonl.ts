/** Streams JSON Lines records out of entries in a zip archive (Node only). */
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import yauzl from "yauzl";

export type JsonRecord = Record<string, unknown>;

function openZip(zipPath: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) =>
    yauzl.open(zipPath, { lazyEntries: true, autoClose: false }, (err, zip) => (err || !zip ? reject(err) : resolve(zip))),
  );
}

/** Walks entries one by one; `visit` returning true stops the walk. */
function walk(zip: yauzl.ZipFile, visit: (e: yauzl.Entry) => Promise<boolean>): Promise<void> {
  return new Promise((resolve, reject) => {
    zip.on("entry", (e: yauzl.Entry) => {
      visit(e).then((stop) => (stop ? resolve() : zip.readEntry()), reject);
    });
    zip.on("end", () => resolve());
    zip.on("error", reject);
    zip.readEntry();
  });
}

function openStream(zip: yauzl.ZipFile, e: yauzl.Entry): Promise<Readable> {
  return new Promise((resolve, reject) =>
    zip.openReadStream(e, (err, s) => (err || !s ? reject(err) : resolve(s))),
  );
}

export async function listZipEntries(zipPath: string): Promise<string[]> {
  const zip = await openZip(zipPath);
  const names: string[] = [];
  try {
    await walk(zip, async (e) => {
      names.push(e.fileName);
      return false;
    });
  } finally {
    zip.close();
  }
  return names;
}

/** Finds the entry whose basename matches (the SDE may nest files in a folder). */
export function findEntry(entries: string[], basename: string): string | undefined {
  return entries.find((e) => e === basename || e.endsWith(`/${basename}`));
}

/** Reads every record of one JSONL entry into `onRecord` (streaming, constant memory). */
export async function readJsonlEntry(
  zipPath: string,
  entryName: string,
  onRecord: (r: JsonRecord) => void,
): Promise<number> {
  const zip = await openZip(zipPath);
  let found = false;
  let n = 0;
  try {
    await walk(zip, async (e) => {
      if (e.fileName !== entryName) return false;
      found = true;
      const rl = createInterface({ input: await openStream(zip, e), crlfDelay: Infinity });
      for await (const line of rl) {
        const t = line.trim();
        if (!t) continue;
        onRecord(JSON.parse(t) as JsonRecord);
        n++;
      }
      return true;
    });
  } finally {
    zip.close();
  }
  if (!found) throw new Error(`entry ${entryName} not found in ${zipPath}`);
  return n;
}
