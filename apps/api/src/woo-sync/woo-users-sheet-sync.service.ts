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
   * Pull WordPress users via REST, merge Square team IDs by email, replace the Users sheet.
   * If WordPress REST env is incomplete, returns without throwing (safe for CI builds).
   */
  async run(): Promise<{
    ok: boolean;
    skipped: boolean;
    reason?: string;
    customersWritten: number;
    squareTeamMembersFetched: number;
    rowsWithSquareTeamId: number;
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
        rowsWithSquareTeamId: 0,
      };
    }

    let teamIdByEmail = new Map<string, string>();
    let squareFetched = 0;
    let squareStaff: Array<{ teamId: string; email: string }> = [];
    try {
      const { teamIdByEmail: map, fetchedTeamMembers, staffInOrder } =
        await this.squareOAuthService.fetchTeamMemberIdByEmailMap();
      teamIdByEmail = map;
      squareFetched = fetchedTeamMembers;
      squareStaff = staffInOrder;
    } catch {
      // Keep sync non-fatal if Square list is unavailable.
    }

    const users = await this.fetchAllWordPressUsers(site, wpUser, wpAppPassword);

    const rows = users.map((u) => {
      const email = (u.email ?? "").trim();
      const emailLower = email.toLowerCase();
      const squareTeamId =
        emailLower !== "" ? (teamIdByEmail.get(emailLower) ?? "") : "";
      const first = (u.first_name ?? "").trim();
      const last = (u.last_name ?? "").trim();
      return {
        user_id: String(u.id),
        first_name: first !== "" ? first : (u.name ?? "").trim(),
        last_name: last,
        email,
        square_team_id: squareTeamId,
      };
    });

    const rowsWithSquareTeamId = rows.filter((r) => r.square_team_id !== "").length;
    const squareEmailTeamIdPairs = squareStaff
      .map((r) => ({
        email: r.email,
        square_team_id: r.teamId,
      }));

    console.table(squareEmailTeamIdPairs);

    await this.sheetsService.replaceUsersSheetRows(rows);

    return {
      ok: true,
      skipped: false,
      customersWritten: rows.length,
      squareTeamMembersFetched: squareFetched,
      rowsWithSquareTeamId,
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
}
