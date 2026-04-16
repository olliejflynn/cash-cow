import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { upsertSquareOAuthCredential } from "@cash-cow/database";
import { createSignedOAuthState, verifySignedOAuthState } from "./oauth-state";
import { encryptTokenPayload } from "./token-crypto";

type SquareEnvironment = "sandbox" | "production";

interface ObtainTokenResponse {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_at?: string;
  merchant_id?: string;
  errors?: Array<{ category?: string; code?: string; detail?: string }>;
}

@Injectable()
export class SquareOAuthService {
  constructor(private readonly config: ConfigService) {}

  private getEnvironment(): SquareEnvironment {
    const raw = (this.config.get<string>("squareEnvironment") ?? "sandbox").toLowerCase();
    if (raw === "production") return "production";
    return "sandbox";
  }

  private connectBaseUrl(): string {
    return this.getEnvironment() === "production"
      ? "https://connect.squareup.com"
      : "https://connect.squareupsandbox.com";
  }

  private requireOAuthConfig(): {
    applicationId: string;
    applicationSecret: string;
    redirectUri: string;
    scopes: string;
    encryptionKey: string;
  } {
    const applicationId = (this.config.get<string>("squareApplicationId") ?? "").trim();
    const applicationSecret = (this.config.get<string>("squareApplicationSecret") ?? "").trim();
    const redirectUri = (this.config.get<string>("squareRedirectUri") ?? "").trim();
    const scopesRaw = (this.config.get<string>("squareOAuthScopes") ?? "").trim();
    const scopes =
      scopesRaw !== ""
        ? scopesRaw
        : "MERCHANT_PROFILE_READ PAYMENTS_READ";
    const encryptionKey = (this.config.get<string>("squareTokenEncryptionKey") ?? "").trim();
    if (!applicationId) {
      throw new Error("SQUARE_APPLICATION_ID is not set");
    }
    if (!applicationSecret) {
      throw new Error("SQUARE_APPLICATION_SECRET is not set");
    }
    if (!redirectUri) {
      throw new Error("SQUARE_REDIRECT_URI is not set");
    }
    if (encryptionKey.length < 16) {
      throw new Error("SQUARE_TOKEN_ENCRYPTION_KEY must be at least 16 characters");
    }
    return { applicationId, applicationSecret, redirectUri, scopes, encryptionKey };
  }

  buildAuthorizationUrl(): { authorizationUrl: string; state: string } {
    const cfg = this.requireOAuthConfig();
    const state = createSignedOAuthState(cfg.encryptionKey);
    const url = new URL("/oauth2/authorize", this.connectBaseUrl());
    url.searchParams.set("client_id", cfg.applicationId);
    url.searchParams.set("scope", cfg.scopes);
    url.searchParams.set("session", "false");
    url.searchParams.set("state", state);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", cfg.redirectUri);
    return { authorizationUrl: url.toString(), state };
  }

  async exchangeCodeAndStoreTokens(code: string, state: string): Promise<{ merchantId: string }> {
    const cfg = this.requireOAuthConfig();
    verifySignedOAuthState(cfg.encryptionKey, state);

    const tokenUrl = new URL("/oauth2/token", this.connectBaseUrl()).toString();
    const res = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Square-Version": "2024-10-17",
      },
      body: JSON.stringify({
        client_id: cfg.applicationId,
        client_secret: cfg.applicationSecret,
        code,
        grant_type: "authorization_code",
        redirect_uri: cfg.redirectUri,
      }),
    });

    const body = (await res.json()) as ObtainTokenResponse;
    if (!res.ok) {
      const detail =
        body.errors?.map((e) => e.detail ?? e.code ?? "").filter(Boolean).join("; ") ||
        `Square token exchange failed (${res.status})`;
      throw new Error(detail);
    }

    const accessToken = (body.access_token ?? "").trim();
    const merchantId = (body.merchant_id ?? "").trim();
    if (!accessToken || !merchantId) {
      throw new Error("Square token response missing access_token or merchant_id");
    }

    const refreshToken = (body.refresh_token ?? "").trim();
    const tokenJson = JSON.stringify({
      access_token: accessToken,
      refresh_token: refreshToken,
    });
    const ciphertext = encryptTokenPayload(cfg.encryptionKey, tokenJson);

    let expiresAt: Date | null = null;
    const expiresRaw = (body.expires_at ?? "").trim();
    if (expiresRaw !== "") {
      const parsed = Date.parse(expiresRaw);
      if (Number.isFinite(parsed)) {
        expiresAt = new Date(parsed);
      }
    }

    await upsertSquareOAuthCredential({
      environment: this.getEnvironment(),
      merchantId,
      tokenCiphertext: ciphertext,
      expiresAt,
    });

    return { merchantId };
  }
}
