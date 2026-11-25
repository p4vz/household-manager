import { createCipheriv, createECDH, createHmac, createPrivateKey, randomBytes, sign } from "node:crypto";

/**
 * Web Push by hand (RFC 8291 message encryption, RFC 8292 VAPID), so push
 * requests go through outboundFetch like every other call. Pure functions;
 * the salt and sender key can be injected for the RFC test vector.
 */
const b64u = (b: Buffer | Uint8Array) => Buffer.from(b).toString("base64url");
const fromB64u = (s: string) => Buffer.from(s, "base64url");
const hmac = (key: Buffer, data: Buffer) => createHmac("sha256", key).update(data).digest();

export type PushKeys = { p256dh: string; auth: string };

/** aes128gcm body for one push message (single record, RFC 8188 framing). */
export function encryptPayload(
  plaintext: Buffer,
  keys: PushKeys,
  opts: { salt?: Buffer; senderPrivateKey?: Buffer } = {},
): Buffer {
  const uaPublic = fromB64u(keys.p256dh);
  const authSecret = fromB64u(keys.auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error("Bad p256dh key");
  if (authSecret.length !== 16) throw new Error("Bad auth secret");
  const ecdh = createECDH("prime256v1");
  if (opts.senderPrivateKey) ecdh.setPrivateKey(opts.senderPrivateKey);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const salt = opts.salt ?? randomBytes(16);

  const prkKey = hmac(authSecret, shared);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12);

  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, body]);
}

export type VapidKeys = { publicKey: string; privateKey: string };

/** A new P-256 key pair, both halves base64url (raw 65-byte public point, 32-byte private scalar). */
export function generateVapidKeys(): VapidKeys {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) };
}

/** `Authorization` header value for a push service (RFC 8292), valid 12 hours. */
export function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string, now = new Date()): string {
  const pub = fromB64u(keys.publicKey);
  const key = createPrivateKey({
    key: { kty: "EC", crv: "P-256", d: keys.privateKey, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) },
    format: "jwk",
  });
  const header = b64u(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64u(
    Buffer.from(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now.getTime() / 1000) + 12 * 3600, sub: subject })),
  );
  const signature = sign("sha256", Buffer.from(`${header}.${claims}`), { key, dsaEncoding: "ieee-p1363" });
  return `vapid t=${header}.${claims}.${b64u(signature)}, k=${keys.publicKey}`;
}
