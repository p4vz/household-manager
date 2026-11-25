import { createDecipheriv, createECDH, createHmac, createPublicKey, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { encryptPayload, generateVapidKeys, vapidAuthorization } from "@/core/push/crypto";

const b = (s: string) => Buffer.from(s, "base64url");

describe("web push crypto", () => {
  it("matches the RFC 8291 appendix A example", () => {
    const body = encryptPayload(
      Buffer.from("When I grow up, I want to be a watermelon"),
      { p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", auth: "BTBZMqHH6r4Tts7J_aSIgg" },
      { salt: b("DGv6ra1nlYgDCS1FRnbzlw"), senderPrivateKey: b("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw") },
    );
    expect(body.toString("base64url")).toBe(
      "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
    );
  });

  it("can be opened by the receiving browser's keys", () => {
    const ua = createECDH("prime256v1");
    ua.generateKeys();
    const auth = Buffer.alloc(16, 7);
    const body = encryptPayload(Buffer.from('{"title":"hi"}'), { p256dh: ua.getPublicKey("base64url"), auth: auth.toString("base64url") });
    const salt = body.subarray(0, 16);
    const asPublic = body.subarray(21, 86);
    const h = (k: Buffer, d: Buffer) => createHmac("sha256", k).update(d).digest();
    const ikm = h(h(auth, ua.computeSecret(asPublic)), Buffer.concat([Buffer.from("WebPush: info\0"), ua.getPublicKey(), asPublic, Buffer.from([1])]));
    const prk = h(salt, ikm);
    const d = createDecipheriv("aes-128-gcm", h(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16), h(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12));
    const ct = body.subarray(86);
    d.setAuthTag(ct.subarray(ct.length - 16));
    const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
    expect(plain.toString()).toBe('{"title":"hi"}\x02');
  });

  it("signs a VAPID token the push service can check", () => {
    const keys = generateVapidKeys();
    const now = new Date("2026-11-25T12:00:00Z");
    const header = vapidAuthorization("https://fcm.googleapis.com/fcm/send/abc", keys, "https://home.example", now);
    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header)!;
    expect(m[4]).toBe(keys.publicKey);
    expect(JSON.parse(b(m[2]).toString())).toEqual({ aud: "https://fcm.googleapis.com", exp: Date.parse("2026-11-26T00:00:00Z") / 1000, sub: "https://home.example" });
    const pub = b(keys.publicKey);
    const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: pub.subarray(1, 33).toString("base64url"), y: pub.subarray(33).toString("base64url") }, format: "jwk" });
    expect(verify("sha256", Buffer.from(`${m[1]}.${m[2]}`), { key, dsaEncoding: "ieee-p1363" }, b(m[3]))).toBe(true);
  });
});
