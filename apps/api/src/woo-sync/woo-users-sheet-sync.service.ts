import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SheetsService } from "../sheets/sheets.service";
import { SquareOAuthService } from "../square-oauth/square-oauth.service";

interface WooCustomer {
  id: number;
  first_name?: string;
  last_name?: string;
  email?: string;
}

@Injectable()
export class WooUsersSheetSyncService {
  constructor(
    private readonly config: ConfigService,
    private readonly sheetsService: SheetsService,
    private readonly squareOAuthService: SquareOAuthService
  ) {}

  /**
   * Pull WooCommerce customers, merge Square team IDs by email, replace the Users sheet.
   * If WooCommerce env is incomplete, logs and returns without throwing (safe for CI builds).
   */
  async run(): Promise<{
    ok: boolean;
    skipped: boolean;
    reason?: string;
    customersWritten: number;
    squareTeamMembersFetched: number;
    rowsWithSquareTeamId: number;
  }> {
    const site = (this.config.get<string>("woocommerceSiteUrl") ?? "")
      .trim()
      .replace(/\/+$/, "");
    const consumerKey = (this.config.get<string>("woocommerceConsumerKey") ?? "").trim();
    const consumerSecret = (this.config.get<string>("woocommerceConsumerSecret") ?? "").trim();

    if (!site || !consumerKey || !consumerSecret) {
      console.warn(
        "[UsersSheetSync] Skipping: set WOOCOMMERCE_SITE_URL, WOOCOMMERCE_CONSUMER_KEY, and WOOCOMMERCE_CONSUMER_SECRET"
      );
      return {
        ok: true,
        skipped: true,
        reason: "woocommerce_env_incomplete",
        customersWritten: 0,
        squareTeamMembersFetched: 0,
        rowsWithSquareTeamId: 0,
      };
    }

    let teamIdByEmail = new Map<string, string>();
    let squareFetched = 0;
    try {
      const { teamIdByEmail: map, fetchedTeamMembers } =
        await this.squareOAuthService.fetchTeamMemberIdByEmailMap();
      teamIdByEmail = map;
      squareFetched = fetchedTeamMembers;
    } catch (err) {
      console.warn(
        "[UsersSheetSync] Square team member list unavailable (continuing without Square_team_ID):",
        err instanceof Error ? err.message : err
      );
    }

    const customers = await this.fetchAllWooCustomers(
      site,
      consumerKey,
      consumerSecret
    );

    const rows = customers.map((c) => {
      const email = (c.email ?? "").trim();
      const emailLower = email.toLowerCase();
      const squareTeamId =
        emailLower !== "" ? (teamIdByEmail.get(emailLower) ?? "") : "";
      return {
        user_id: String(c.id),
        first_name: (c.first_name ?? "").trim(),
        last_name: (c.last_name ?? "").trim(),
        email,
        square_team_id: squareTeamId,
      };
    });

    const rowsWithSquareTeamId = rows.filter((r) => r.square_team_id !== "").length;

    await this.sheetsService.replaceUsersSheetRows(rows);

    console.log(
      `[UsersSheetSync] Wrote ${rows.length} user row(s); ${rowsWithSquareTeamId} with Square_team_ID; Square members fetched: ${squareFetched}`
    );

    return {
      ok: true,
      skipped: false,
      customersWritten: rows.length,
      squareTeamMembersFetched: squareFetched,
      rowsWithSquareTeamId,
    };
  }

  private async fetchAllWooCustomers(
    site: string,
    consumerKey: string,
    consumerSecret: string
  ): Promise<WooCustomer[]> {
    const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString("base64");
    const perPage = 100;
    const all: WooCustomer[] = [];
    let page = 1;

    for (;;) {
      const url = new URL(`${site}/wp-json/wc/v3/customers`);
      url.searchParams.set("per_page", String(perPage));
      url.searchParams.set("page", String(page));

      const res = await fetch(url.toString(), {
        headers: {
          Authorization: `Basic ${auth}`,
          Accept: "application/json",
        },
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(
          `WooCommerce customers fetch failed (${res.status}): ${text.slice(0, 500)}`
        );
      }

      const batch = (await res.json()) as WooCustomer[];
      if (!Array.isArray(batch) || batch.length === 0) break;
      all.push(...batch);
      if (batch.length < perPage) break;
      page += 1;
    }

    return all;
  }
}
