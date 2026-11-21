import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { open, seal } from "@/core/secrets/secret-box";
import { openBytes, sealBytes } from "@/modules/trips/vault";

beforeAll(() => {
  process.env.AUTH_SECRET ??= "test-auth-secret-at-least-32-characters-long";
  process.env.DOC_VAULT_KEY ??= randomBytes(32).toString("base64");
});

describe("secret-box", () => {
  it("round-trips", () => {
    expect(open(seal("https://user:pw@bridge.simplefin.org/x"))).toBe("https://user:pw@bridge.simplefin.org/x");
  });

  it("rejects a truncated auth tag", () => {
    const [v, iv, tag, body] = seal("hello").split(".");
    const short = Buffer.from(tag, "base64").subarray(0, 4).toString("base64");
    expect(() => open([v, iv, short, body].join("."))).toThrow();
  });
});

describe("documents vault", () => {
  it("round-trips with a fresh nonce each time", () => {
    const plain = Buffer.from("passport scan");
    const a = sealBytes(plain);
    const b = sealBytes(plain);
    expect(a.iv.equals(b.iv)).toBe(false);
    expect(openBytes(a).equals(plain)).toBe(true);
  });

  it("rejects a truncated or tampered auth tag", () => {
    const s = sealBytes(Buffer.from("passport scan"));
    expect(() => openBytes({ ...s, authTag: s.authTag.subarray(0, 4) })).toThrow();
    const flipped = Buffer.from(s.authTag);
    flipped[0] ^= 1;
    expect(() => openBytes({ ...s, authTag: flipped })).toThrow();
  });
});
