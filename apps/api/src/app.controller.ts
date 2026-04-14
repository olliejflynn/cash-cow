import { Controller, Get, Head, HttpCode, Post } from "@nestjs/common";

/**
 * WooCommerce probes the webhook base URL (e.g. POST "/") when validating delivery URL.
 * A 502 here fails webhook setup even though POST /webhooks/woocommerce/order works.
 */
@Controller()
export class AppController {
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
}
