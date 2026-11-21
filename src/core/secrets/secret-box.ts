import "server-only";
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/**
 * AES-256-GCM for credentials the app obtains at runtime (the SimpleFIN
 * access URL). The key is derived from AUTH_SECRET with HKDF, so the value
 * in the database is useless without the server's environment. Rotating
 * AUTH_SECRET means redoing the SimpleFIN setup.
 */
function key(): Buffer {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 32) throw new Error("AUTH_SECRET is not configured");
  return Buffer.from(hkdfSync("sha256", secret, "household-manager", "secret-box:v1", 32));
}

export function seal(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), body.toString("base64")].join(".");
}

export function open(sealed: string): string {
  const [v, iv, tag, body] = sealed.split(".");
  if (v !== "v1" || !iv || !tag || !body) throw new Error("Unrecognized sealed value");
  const authTag = Buffer.from(tag, "base64");
  // Node accepts truncated GCM tags unless the length is pinned; a short tag is much easier to forge.
  if (authTag.length !== 16) throw new Error("Unrecognized sealed value");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"), { authTagLength: 16 });
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(Buffer.from(body, "base64")), decipher.final()]).toString("utf8");
}
