import { Module } from "@nestjs/common";
import { SquareOAuthController } from "./square-oauth.controller";
import { SquareOAuthService } from "./square-oauth.service";

@Module({
  controllers: [SquareOAuthController],
  providers: [SquareOAuthService],
  exports: [SquareOAuthService],
})
export class SquareOAuthModule {}
