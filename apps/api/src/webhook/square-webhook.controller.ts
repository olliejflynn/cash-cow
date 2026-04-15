import { Body, Controller, HttpCode, Post } from "@nestjs/common";

@Controller("webhooks/square")
export class SquareWebhookController {
  @Post("payment")
  @HttpCode(200)
  async handlePaymentWebhook(@Body() body: unknown): Promise<{ ok: boolean }> {
    console.log(
      JSON.stringify(
        {
          event: "square_payment_webhook_received",
          received_at: new Date().toISOString(),
          payload: body,
        },
        null,
        2
      )
    );

    return { ok: true };
  }
}
