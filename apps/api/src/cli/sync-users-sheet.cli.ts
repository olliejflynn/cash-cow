import "../env-loader";
import { disconnect } from "@cash-cow/database";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../app.module";
import { WooUsersSheetSyncService } from "../woo-sync/woo-users-sheet-sync.service";

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ["error", "warn", "log"],
  });
  try {
    const sync = app.get(WooUsersSheetSyncService);
    await sync.run();
  } finally {
    await app.close();
    await disconnect();
  }
}

main().catch((err) => {
  console.error("[sync-users-sheet.cli] Failed:", err);
  process.exit(1);
});
