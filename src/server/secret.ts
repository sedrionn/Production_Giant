/**
 * Encrypts refresh tokens at rest (AES-256-GCM). The key lives in data/secret.key,
 * created on first use, never committed. Losing it = re-add characters, nothing else.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

let key: Buffer | null = null;

function loadKey(): Buffer {
  if (key) return key;
  if (process.env.PG_SECRET_KEY) return (key = crypto.createHash("sha256").update(process.env.PG_SECRET_KEY).digest());
  const file = path.resolve("data/secret.key");
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, crypto.randomBytes(32).toString("base64"), { mode: 0o600 });
  }
  return (key = Buffer.from(fs.readFileSync(file, "utf8").trim(), "base64"));
}

export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", loadKey(), iv);
  const data = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", iv.toString("base64"), c.getAuthTag().toString("base64"), data.toString("base64")].join(".");
}

export function decrypt(sealed: string): string {
  const [v, iv, tag, data] = sealed.split(".");
  if (v !== "v1") throw new Error("Неизвестный формат зашифрованного токена");
  const d = crypto.createDecipheriv("aes-256-gcm", loadKey(), Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(data, "base64")), d.final()]).toString("utf8");
}
