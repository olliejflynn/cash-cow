/**
 * Load .env before any other app code so Prisma and other libs see process.env.
 * This is monorepo-safe: it searches a few likely locations for the root .env.
 */
import { config as dotenvConfig } from "dotenv";
import { existsSync } from "fs";
import { resolve } from "path";

function loadEnv() {
  const candidates = [
    resolve(process.cwd(), ".env"),
    resolve(process.cwd(), "../.env"),
    resolve(process.cwd(), "../../.env"),

    // When running compiled code from apps/api/dist/..., __dirname is inside dist.
    resolve(__dirname, "../../../.env"),
    resolve(__dirname, "../../../../.env"),
  ];

  for (const p of candidates) {
    if (existsSync(p)) {
      dotenvConfig({ path: p });
      // Optional debug:
      // console.log(`[env-loader] loaded ${p}`);
      return p;
    }
  }

  // Optional: make it loud if missing (useful during setup)
  // console.warn("[env-loader] No .env file found in expected locations.");
  return null;
}

loadEnv();
