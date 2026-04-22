import { Module } from "@nestjs/common";
import { SheetsModule } from "../sheets/sheets.module";
import { TelegramWebhookController } from "./telegram-webhook.controller";

@Module({
  imports: [SheetsModule],
  controllers: [TelegramWebhookController],
})
export class TelegramModule {}
