import { Module } from "@nestjs/common";
import { TelegramWebhookController } from "./telegram-webhook.controller";

@Module({
  controllers: [TelegramWebhookController],
})
export class TelegramModule {}
