const encoder = new TextEncoder();

export function bytes(value: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(value);
}

export function sameSecret(candidate: string | undefined, expected: string): boolean {
  return candidate != null && sameBytes(encoder.encode(candidate), encoder.encode(expected));
}

export async function verifyBase64Hmac(
  secret: string,
  parts: readonly Uint8Array[],
  signature: string | undefined,
): Promise<boolean> {
  const candidate = signature == null ? undefined : base64(signature);
  return candidate != null && sameBytes(candidate, await hmac(secret, parts));
}

export async function verifyHexHmac(
  secret: string,
  parts: readonly Uint8Array[],
  signature: string | undefined,
): Promise<boolean> {
  const candidate = signature == null ? undefined : hex(signature);
  return candidate != null && sameBytes(candidate, await hmac(secret, parts));
}

export async function verifyEd25519(
  publicKey: string,
  parts: readonly Uint8Array[],
  signature: string | undefined,
): Promise<boolean> {
  const candidate = signature == null ? undefined : base64(signature);
  const key = candidate == null ? undefined : await importEd25519PublicKey(publicKey);
  if (candidate == null || key == null) return false;
  return crypto.subtle.verify({ name: "Ed25519" }, key, candidate, concat(parts));
}

async function hmac(secret: string, parts: readonly Uint8Array[]): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { hash: "SHA-256", name: "HMAC" }, false, [
    "sign",
  ]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, concat(parts)));
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

async function importEd25519PublicKey(value: string): Promise<CryptoKey | undefined> {
  const key = base64(value);
  if (key == null) return;
  for (const format of ["raw", "spki"] as const) {
    try {
      return await crypto.subtle.importKey(format, key, { name: "Ed25519" }, false, ["verify"]);
    } catch {
      // Try the other supported encoding before giving up.
    }
  }
  return;
}

function base64(value: string): Uint8Array<ArrayBuffer> | undefined {
  try {
    return new Uint8Array(Array.from(atob(value), (character) => character.charCodeAt(0)));
  } catch {
    return;
  }
}

function hex(value: string): Uint8Array | undefined {
  if (value.length == 0 || value.length % 2 != 0 || !/^[0-9a-f]+$/i.test(value)) return;
  return Uint8Array.from({ length: value.length / 2 }, (_, index) =>
    Number.parseInt(value.slice(index * 2, index * 2 + 2), 16),
  );
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.byteLength ^ right.byteLength;
  const length = Math.max(left.byteLength, right.byteLength);
  for (let index = 0; index < length; index += 1) difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return difference == 0;
}
