import { Module } from "@nestjs/common";
import { SheetsModule } from "../sheets/sheets.module";
import { WebhookController } from "./webhook.controller";

@Module({
  imports: [SheetsModule],
  controllers: [WebhookController],
})
export class WebhookModule {}
