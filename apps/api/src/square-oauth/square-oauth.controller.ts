import {
  BadRequestException,
  Controller,
  Get,
  Headers,
  Post,
  Query,
  Res,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Response } from "express";
import { SquareOAuthService } from "./square-oauth.service";

@Controller("oauth/square")
export class SquareOAuthController {
  constructor(
    private readonly squareOAuth: SquareOAuthService,
    private readonly config: ConfigService
  ) {}

  @Get("authorize-url")
  authorizeUrl(@Headers("authorization") authorization?: string): { authorizationUrl: string } {
    this.assertSetupAuthorized(authorization);
    try {
      const { authorizationUrl } = this.squareOAuth.buildAuthorizationUrl();
      return { authorizationUrl };
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "OAuth configuration error";
      throw new BadRequestException(message);
    }
  }

  @Get("callback")
  async callback(
    @Query("code") code: string | undefined,
    @Query("state") state: string | undefined,
    @Query("error") error: string | undefined,
    @Query("error_description") errorDescription: string | undefined,
    @Res() res: Response
  ): Promise<void> {
    if (error) {
      const msg = [error, errorDescription].filter(Boolean).join(": ");
      res.status(400).type("html").send(htmlPage("Square authorization failed", msg));
      return;
    }
    const c = (code ?? "").trim();
    const s = (state ?? "").trim();
    if (!c || !s) {
      res.status(400).type("html").send(htmlPage("Missing parameters", "code and state are required."));
      return;
    }
    try {
      const { merchantId } = await this.squareOAuth.exchangeCodeAndStoreTokens(c, s);
      res
        .status(200)
        .type("html")
        .send(
          htmlPage(
            "Square connected",
            `Credentials stored for merchant <code>${escapeHtml(merchantId)}</code>. You can close this window.`
          )
        );
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Token exchange failed";
      res.status(400).type("html").send(htmlPage("Could not complete Square OAuth", escapeHtml(message)));
    }
  }

  @Post("sync-sellers-team-ids")
  async syncSellersTeamIds(
    @Headers("authorization") authorization?: string
  ): Promise<{
    ok: boolean;
    fetchedTeamMembers: number;
    mappedByEmail: number;
    updatedSellers: number;
  }> {
    this.assertSetupAuthorized(authorization);
    try {
      const result = await this.squareOAuth.syncSellerSquareTeamIds();
      return {
        ok: true,
        ...result,
      };
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Failed to sync seller team IDs";
      throw new BadRequestException(message);
    }
  }

  @Post("sync-sellers-team-ids-m")
  async syncSellersTeamIdsM(
    @Headers("authorization") authorization?: string
  ): Promise<{
    ok: boolean;
    fetchedTeamMembers: number;
    mappedByEmail: number;
    updatedSellers: number;
  }> {
    this.assertSetupAuthorized(authorization);
    try {
      const result = await this.squareOAuth.syncSellerMSquareTeamIds();
      return {
        ok: true,
        ...result,
      };
    } catch (e: unknown) {
      const message =
        e instanceof Error ? e.message : "Failed to sync seller M team IDs";
      throw new BadRequestException(message);
    }
  }

  private assertSetupAuthorized(authorization: string | undefined): void {
    const setupSecret = (this.config.get<string>("squareOAuthSetupSecret") ?? "").trim();
    if (setupSecret === "") {
      return;
    }
    const expected = `Bearer ${setupSecret}`;
    const got = (authorization ?? "").trim();
    if (got !== expected) {
      throw new UnauthorizedException("Missing or invalid Authorization for OAuth setup");
    }
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function htmlPage(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 2rem; line-height: 1.5; }
      code { background: #f2f2f2; padding: 0.1rem 0.25rem; border-radius: 4px; }
    </style>
  </head>
  <body>
    <h1>${escapeHtml(title)}</h1>
    <p>${bodyHtml}</p>
  </body>
</html>`;
}
