import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { config } from "./config";
import { DatabaseModule } from "./database/database.module";
import { WebhookModule } from "./webhook/webhook.module";
import { SheetsModule } from "./sheets/sheets.module";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [config],
      ignoreEnvFile: true, // <-- add this
    }),
    DatabaseModule,
    WebhookModule,
    SheetsModule,
  ],
})
export class AppModule {}
