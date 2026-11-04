import { describe, expect, it } from "vitest";
import { bytes, verifyEd25519 } from "./signature.ts";

interface TestKeys {
  readonly privateKey: CryptoKey;
  readonly rawPublicKey: string;
  readonly spkiPublicKey: string;
}

async function createKeys(): Promise<TestKeys> {
  const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  if (!("privateKey" in keys)) throw new Error("Ed25519 key generation returned a single key.");
  return {
    privateKey: keys.privateKey,
    rawPublicKey: toBase64(new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey))),
    spkiPublicKey: toBase64(new Uint8Array(await crypto.subtle.exportKey("spki", keys.publicKey))),
  };
}

function toBase64(value: Uint8Array): string {
  return Buffer.from(value).toString("base64");
}

function concat(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const size = parts.reduce((total, part) => total + part.byteLength, 0);
  const source = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    source.set(part, offset);
    offset += part.byteLength;
  }
  return source;
}

async function signed(parts: readonly Uint8Array[], privateKey: CryptoKey): Promise<string> {
  return toBase64(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, privateKey, concat(parts))));
}

describe("verifyEd25519", () => {
  it("accepts a signature from the matching key over the concatenated parts", async () => {
    const { privateKey, rawPublicKey } = await createKeys();
    const parts = [bytes("1712345678|"), bytes('{"data":{"event_type":"message.received"}}')];
    await expect(verifyEd25519(rawPublicKey, parts, await signed(parts, privateKey))).resolves.toBe(true);
  });

  it("accepts an SPKI encoded public key", async () => {
    const { privateKey, spkiPublicKey } = await createKeys();
    const parts = [bytes("1712345678|"), bytes("payload")];
    await expect(verifyEd25519(spkiPublicKey, parts, await signed(parts, privateKey))).resolves.toBe(true);
  });

  it("rejects tampered parts, other keys and malformed inputs", async () => {
    const { privateKey, rawPublicKey } = await createKeys();
    const parts = [bytes("1712345678|"), bytes("payload")];
    const signature = await signed(parts, privateKey);
    await expect(verifyEd25519(rawPublicKey, [bytes("1712345678|"), bytes("payload!")], signature)).resolves.toBe(
      false,
    );
    await expect(verifyEd25519((await createKeys()).rawPublicKey, parts, signature)).resolves.toBe(false);
    await expect(verifyEd25519(rawPublicKey, parts, undefined)).resolves.toBe(false);
    await expect(verifyEd25519(rawPublicKey, parts, "not base64")).resolves.toBe(false);
    await expect(verifyEd25519("not base64", parts, signature)).resolves.toBe(false);
  });
});
