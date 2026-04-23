import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SheetsService } from "../sheets/sheets.service";
import { SquareOAuthService } from "../square-oauth/square-oauth.service";

/** WordPress REST `/wp/v2/users` (context=edit) — fields used for the sheet. */
interface WpRestUser {
  id: number;
  first_name?: string;
  last_name?: string;
  email?: string;
  name?: string;
}

@Injectable()
export class WooUsersSheetSyncService {
  constructor(
    private readonly config: ConfigService,
    private readonly sheetsService: SheetsService,
    private readonly squareOAuthService: SquareOAuthService
  ) {}

  /**
   * Pull WordPress users via REST and replace the Users sheet (WordPress fields only).
   * Square team member lists are still fetched and logged for manual copy into sheets.
   * If WordPress REST env is incomplete, returns without throwing (safe for CI builds).
   */
  async run(): Promise<{
    ok: boolean;
    skipped: boolean;
    reason?: string;
    customersWritten: number;
    squareTeamMembersFetched: number;
    mSquareTeamMembersFetched: number;
    rowsWithSquareTeamId: number;
    rowsWithMSquareTeamId: number;
  }> {
    const site = (this.config.get<string>("wordpressRestSiteUrl") ?? "")
      .trim()
      .replace(/\/+$/, "");
    const wpUser = (this.config.get<string>("wordpressRestUsername") ?? "").trim();
    const wpAppPassword = (
      this.config.get<string>("wordpressRestApplicationPassword") ?? ""
    ).trim();

    if (!site || !wpUser || !wpAppPassword) {
      return {
        ok: true,
        skipped: true,
        reason: "wordpress_rest_env_incomplete",
        customersWritten: 0,
        squareTeamMembersFetched: 0,
        mSquareTeamMembersFetched: 0,
        rowsWithSquareTeamId: 0,
        rowsWithMSquareTeamId: 0,
      };
    }

    let squareFetched = 0;
    let mSquareFetched = 0;
    let primaryStaffInOrder: Array<{ teamId: string; email: string }> = [];
    let mStaffInOrder: Array<{ teamId: string; email: string }> = [];
    try {
      const { fetchedTeamMembers, staffInOrder } =
        await this.squareOAuthService.fetchTeamMemberIdByEmailMap("primary");
      squareFetched = fetchedTeamMembers;
      primaryStaffInOrder = staffInOrder;
    } catch (err) {
      console.warn(
        "[UsersSheetSync] Square team-member fetch failed (primary):",
        err instanceof Error ? err.message : err
      );
    }
    try {
      const { fetchedTeamMembers, staffInOrder } =
        await this.squareOAuthService.fetchTeamMemberIdByEmailMap("m");
      mSquareFetched = fetchedTeamMembers;
      mStaffInOrder = staffInOrder;
    } catch (err) {
      console.warn(
        "[UsersSheetSync] Square team-member fetch failed (m):",
        err instanceof Error ? err.message : err
      );
    }

    this.printSquareAccountTeamIds("primary", primaryStaffInOrder);
    this.printSquareAccountTeamIds("m", mStaffInOrder);

    const users = await this.fetchAllWordPressUsers(site, wpUser, wpAppPassword);

    const rows = users.map((u) => {
      const email = (u.email ?? "").trim();
      const first = (u.first_name ?? "").trim();
      const last = (u.last_name ?? "").trim();
      return {
        user_id: String(u.id),
        first_name: first !== "" ? first : (u.name ?? "").trim(),
        last_name: last,
        email,
        square_team_id: "",
        m_square_team_id: "",
      };
    });

    await this.sheetsService.replaceUsersSheetRows(rows);

    return {
      ok: true,
      skipped: false,
      customersWritten: rows.length,
      squareTeamMembersFetched: squareFetched,
      mSquareTeamMembersFetched: mSquareFetched,
      rowsWithSquareTeamId: 0,
      rowsWithMSquareTeamId: 0,
    };
  }

  private async fetchAllWordPressUsers(
    site: string,
    username: string,
    applicationPassword: string
  ): Promise<WpRestUser[]> {
    const auth = Buffer.from(
      `${username}:${applicationPassword}`,
      "utf8"
    ).toString("base64");
    const perPage = 100;
    const all: WpRestUser[] = [];
    let page = 1;

    for (;;) {
      const url = new URL(`${site}/wp-json/wp/v2/users`);
      url.searchParams.set("per_page", String(perPage));
      url.searchParams.set("page", String(page));
      url.searchParams.set("context", "edit");

      const res = await fetch(url.toString(), {
        headers: {
          Authorization: `Basic ${auth}`,
          Accept: "application/json",
        },
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(
          `WordPress users fetch failed (${res.status}): ${text.slice(0, 500)}`
        );
      }

      const raw = await res.json();
      if (!Array.isArray(raw)) {
        throw new Error(
          "WordPress users response was not a JSON array (check REST URL, user capabilities, and application password)"
        );
      }
      const batch = raw as WpRestUser[];
      if (batch.length === 0) break;
      all.push(...batch);
      if (batch.length < perPage) break;
      page += 1;
    }

    return all;
  }

  private printSquareAccountTeamIds(
    accountKey: "primary" | "m",
    staffInOrder: Array<{ teamId: string; email: string }>
  ): void {
    const rows = staffInOrder.map((staff) => ({
      square_account: accountKey,
      team_id: staff.teamId,
      email: staff.email,
    }));
    console.log(
      `[UsersSheetSync] Square staff listing (${accountKey}): ${rows.length} row(s)`
    );
    if (rows.length === 0) {
      console.warn(
        `[UsersSheetSync] No Square team rows for "${accountKey}" — check OAuth credentials, SQUARE_PRIMARY_MERCHANT_ID / SQUARE_M_MERCHANT_ID, and logs above for fetch errors.`
      );
      return;
    }
    console.table(rows);
    // npm/CI logs often render console.table poorly; JSON is always visible in build output.
    console.log(
      `[UsersSheetSync] Square staff (${accountKey}) JSON:\n${JSON.stringify(rows, null, 2)}`
    );
  }
}
