import { Module } from "@nestjs/common";
import { SheetsModule } from "../sheets/sheets.module";
import { SquareOAuthModule } from "../square-oauth/square-oauth.module";
import { WebhookController } from "./webhook.controller";
import { SquareWebhookController } from "./square-webhook.controller";

@Module({
  imports: [SheetsModule, SquareOAuthModule],
  controllers: [WebhookController, SquareWebhookController],
})
export class WebhookModule {}
