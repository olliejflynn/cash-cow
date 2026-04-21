import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { config } from "./config";
import { AppController } from "./app.controller";
import { SquareOAuthModule } from "./square-oauth/square-oauth.module";
import { WebhookModule } from "./webhook/webhook.module";
import { WooUsersSheetSyncModule } from "./woo-sync/woo-users-sheet-sync.module";
import { TelegramModule } from "./telegram/telegram.module";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [config],
      ignoreEnvFile: true, // <-- add this
    }),
    WebhookModule,
    SquareOAuthModule,
    WooUsersSheetSyncModule,
    TelegramModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
