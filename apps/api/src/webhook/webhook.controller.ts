import { Controller, Post, Body, HttpCode, UseGuards } from "@nestjs/common";
import { WebhookSecretGuard } from "./webhook-secret.guard";

@Controller("webhooks/woocommerce")
@UseGuards(WebhookSecretGuard)
export class WebhookController {
  @Post("order")
  @HttpCode(200)
  handleOrder(@Body() body: unknown): { ok: boolean } {
    console.log(JSON.stringify(body ?? null, null, 2));
    return { ok: true };
  }
}
