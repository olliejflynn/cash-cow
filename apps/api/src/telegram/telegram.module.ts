import { Module } from "@nestjs/common";
import { SheetsModule } from "../sheets/sheets.module";
import { SquareOAuthModule } from "../square-oauth/square-oauth.module";
import { TelegramWebhookController } from "./telegram-webhook.controller";

@Module({
  imports: [SheetsModule, SquareOAuthModule],
  controllers: [TelegramWebhookController],
})
export class TelegramModule {}
