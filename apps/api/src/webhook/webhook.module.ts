import { Module } from "@nestjs/common";
import { SheetsModule } from "../sheets/sheets.module";
import { WebhookController } from "./webhook.controller";
import { SquareWebhookController } from "./square-webhook.controller";

@Module({
  imports: [SheetsModule],
  controllers: [WebhookController, SquareWebhookController],
})
export class WebhookModule {}
