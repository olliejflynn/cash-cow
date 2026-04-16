import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";

const INFO_TOKEN = Buffer.from("square-oauth-token-v1", "utf8");

function deriveAesKey(masterSecret: string): Buffer {
  return createHash("sha256")
    .update(INFO_TOKEN)
    .update("|", "utf8")
    .update(masterSecret, "utf8")
    .digest();
}

/**
 * AES-256-GCM encrypt. Output is base64url(iv || ciphertext || tag).
 */
export function encryptTokenPayload(masterSecret: string, plaintextUtf8: string): string {
  const key = deriveAesKey(masterSecret);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintextUtf8, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ciphertext, tag]).toString("base64url");
}

export function decryptTokenPayload(masterSecret: string, payloadB64Url: string): string {
  const key = deriveAesKey(masterSecret);
  const raw = Buffer.from(payloadB64Url, "base64url");
  if (raw.length < 12 + 16) {
    throw new Error("Invalid encrypted token payload");
  }
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(raw.length - 16);
  const ciphertext = raw.subarray(12, raw.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
