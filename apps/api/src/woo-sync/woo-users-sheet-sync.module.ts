import { Module } from "@nestjs/common";
import { SheetsModule } from "../sheets/sheets.module";
import { SquareOAuthModule } from "../square-oauth/square-oauth.module";
import { WooUsersSheetSyncService } from "./woo-users-sheet-sync.service";

@Module({
  imports: [SheetsModule, SquareOAuthModule],
  providers: [WooUsersSheetSyncService],
  exports: [WooUsersSheetSyncService],
})
export class WooUsersSheetSyncModule {}
