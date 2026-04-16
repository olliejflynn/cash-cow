import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { config } from "./config";
import { AppController } from "./app.controller";
import { SquareOAuthModule } from "./square-oauth/square-oauth.module";
import { WebhookModule } from "./webhook/webhook.module";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [config],
      ignoreEnvFile: true, // <-- add this
    }),
    WebhookModule,
    SquareOAuthModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
