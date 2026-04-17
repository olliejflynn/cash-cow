import {
  Controller,
  Get,
  Head,
  HttpCode,
  Post,
  Headers,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { WooUsersSheetSyncService } from "./woo-sync/woo-users-sheet-sync.service";

/**
 * WooCommerce probes the webhook base URL (e.g. POST "/") when validating delivery URL.
 * A 502 here fails webhook setup even though POST /webhooks/woocommerce/order works.
 */
@Controller()
export class AppController {
  constructor(
    private readonly config: ConfigService,
    private readonly wooUsersSheetSync: WooUsersSheetSyncService
  ) {}
  @Get()
  rootGet(): { ok: boolean } {
    return { ok: true };
  }

  @Head()
  @HttpCode(200)
  rootHead(): void {
    // HEAD must not include a body
  }

  @Post()
  @HttpCode(200)
  rootPost(): { ok: boolean } {
    return { ok: true };
  }

  /**
   * Manual refresh of the Users sheet. Requires Authorization: Bearer <USERS_SHEET_SYNC_SECRET>.
   */
  @Post("internal/sync-users-sheet")
  @HttpCode(200)
  async syncUsersSheet(
    @Headers("authorization") authorization: string | undefined
  ): Promise<unknown> {
    const secret = (this.config.get<string>("usersSheetSyncSecret") ?? "").trim();
    if (!secret) {
      return {
        ok: false,
        error: "USERS_SHEET_SYNC_SECRET is not configured",
      };
    }
    const expected = `Bearer ${secret}`;
    if ((authorization ?? "").trim() !== expected) {
      throw new UnauthorizedException();
    }
    return this.wooUsersSheetSync.run();
  }
}
