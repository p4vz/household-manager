import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { open, seal } from "@/core/secrets/secret-box";
import { openBytes, sealBytes } from "@/modules/trips/vault";

beforeAll(() => {
  process.env.AUTH_SECRET ??= randomBytes(32).toString("hex");
  process.env.DOC_VAULT_KEY = randomBytes(32).toString("base64");
});

describe("AES-GCM tag length", () => {
  it("secret-box round-trips and refuses a truncated tag", () => {
    const sealed = seal("https://user:pass@bridge.simplefin.org/simplefin");
    expect(open(sealed)).toBe("https://user:pass@bridge.simplefin.org/simplefin");
    const [v, iv, tag, body] = sealed.split(".");
    const short = Buffer.from(tag, "base64").subarray(0, 4).toString("base64");
    expect(() => open([v, iv, short, body].join("."))).toThrow();
  });

  it("vault round-trips and refuses a truncated tag", () => {
    const sealed = sealBytes(Buffer.from("passport scan"));
    expect(openBytes(sealed).toString()).toBe("passport scan");
    expect(() => openBytes({ ...sealed, authTag: sealed.authTag.subarray(0, 4) })).toThrow();
  });
});
