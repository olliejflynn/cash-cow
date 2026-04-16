import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";

const STATE_MAX_AGE_MS = 15 * 60 * 1000;
const INFO_STATE = Buffer.from("square-oauth-state-v1", "utf8");

function deriveStateSecret(masterSecret: string): Buffer {
  return createHash("sha256")
    .update(INFO_STATE)
    .update("|", "utf8")
    .update(masterSecret, "utf8")
    .digest();
}

export function createSignedOAuthState(masterSecret: string): string {
  const payload = {
    t: Date.now(),
    n: randomBytes(16).toString("hex"),
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const secret = deriveStateSecret(masterSecret);
  const sig = createHmac("sha256", secret).update(payloadB64).digest("base64url");
  return `${payloadB64}.${sig}`;
}

export function verifySignedOAuthState(masterSecret: string, state: string): void {
  const parts = state.split(".");
  if (parts.length !== 2) {
    throw new Error("Invalid OAuth state");
  }
  const [payloadB64, sigB64] = parts;
  const secret = deriveStateSecret(masterSecret);
  const expected = createHmac("sha256", secret).update(payloadB64).digest();
  const actual = Buffer.from(sigB64, "base64url");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new Error("Invalid OAuth state signature");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid OAuth state payload");
  }
  if (!parsed || typeof parsed !== "object" || !("t" in parsed)) {
    throw new Error("Invalid OAuth state shape");
  }
  const t = (parsed as { t?: unknown }).t;
  if (typeof t !== "number" || !Number.isFinite(t)) {
    throw new Error("Invalid OAuth state timestamp");
  }
  if (Date.now() - t > STATE_MAX_AGE_MS) {
    throw new Error("OAuth state expired");
  }
}
