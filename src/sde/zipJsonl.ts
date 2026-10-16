/** Streams JSON Lines records out of entries in a zip archive (Node only). */
import { StringDecoder } from "node:string_decoder";
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

/**
 * Splits a byte stream into lines and feeds parsed JSON records to `onRecord`.
 * Explicit 'data'/'end'/'error' handling (instead of readline's async iterator) so a
 * corrupt entry or a bad line always rejects — never hangs the process silently.
 */
export function consumeJsonl(stream: Readable, onRecord: (r: JsonRecord) => void): Promise<number> {
  return new Promise((resolve, reject) => {
    const decoder = new StringDecoder("utf8");
    let tail = "";
    let n = 0;
    let lineNo = 0;
    let failed = false;
    const fail = (e: unknown) => {
      if (failed) return;
      failed = true;
      stream.destroy();
      reject(e);
    };
    const handle = (line: string) => {
      lineNo++;
      const t = line.trim();
      if (!t) return;
      try {
        onRecord(JSON.parse(t) as JsonRecord);
      } catch (e) {
        throw new Error(`line ${lineNo}: ${(e as Error).message}; text: ${t.slice(0, 200)}`);
      }
      n++;
    };
    stream.on("data", (chunk: Buffer) => {
      if (failed) return;
      try {
        const parts = (tail + decoder.write(chunk)).split("\n");
        tail = parts.pop() ?? "";
        for (const line of parts) handle(line);
      } catch (e) {
        fail(e);
      }
    });
    stream.on("end", () => {
      if (failed) return;
      try {
        handle(tail + decoder.end());
        resolve(n);
      } catch (e) {
        fail(e);
      }
    });
    stream.on("error", fail);
  });
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
      n = await consumeJsonl(await openStream(zip, e), onRecord);
      return true;
    });
  } finally {
    zip.close();
  }
  if (!found) throw new Error(`entry ${entryName} not found in ${zipPath}`);
  return n;
}
