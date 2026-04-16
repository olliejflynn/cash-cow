import { Module } from "@nestjs/common";
import { SheetsModule } from "../sheets/sheets.module";
import { SquareOAuthController } from "./square-oauth.controller";
import { SquareOAuthService } from "./square-oauth.service";

@Module({
  imports: [SheetsModule],
  controllers: [SquareOAuthController],
  providers: [SquareOAuthService],
  exports: [SquareOAuthService],
})
export class SquareOAuthModule {}
