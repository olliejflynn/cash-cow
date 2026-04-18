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
   * If WordPress REST env is incomplete, logs and returns without throwing (safe for CI builds).
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
      console.warn(
        "[UsersSheetSync] Skipping: set WORDPRESS_REST_USERNAME, WORDPRESS_REST_APPLICATION_PASSWORD, and WORDPRESS_SITE_URL (or WOOCOMMERCE_SITE_URL as the same site base URL)"
      );
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
    try {
      const { teamIdByEmail: map, fetchedTeamMembers } =
        await this.squareOAuthService.fetchTeamMemberIdByEmailMap();
      teamIdByEmail = map;
      squareFetched = fetchedTeamMembers;
      console.log(
        "[UsersSheetSync] Square team-member map loaded",
        JSON.stringify({
          square_team_member_rows: fetchedTeamMembers,
          distinct_emails_with_team_id: map.size,
        })
      );
    } catch (err) {
      console.warn(
        "[UsersSheetSync] Square team member list unavailable (continuing without Square_team_ID):",
        err instanceof Error ? err.message : err
      );
    }

    const users = await this.fetchAllWordPressUsers(site, wpUser, wpAppPassword);
    console.log(
      "[UsersSheetSync] WordPress users API finished",
      JSON.stringify({
        total_users: users.length,
        sample_ids: users.slice(0, 5).map((u) => u.id),
        sample_emails_present: users
          .slice(0, 3)
          .map((u) => ((u.email ?? "").trim() !== "" ? "yes" : "no")),
      })
    );

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

    console.log(
      "[UsersSheetSync] About to write Google Sheet",
      JSON.stringify({
        data_rows: rows.length,
        rows_with_square_team_id: rowsWithSquareTeamId,
        sample_row: rows[0] ?? null,
      })
    );
    await this.sheetsService.replaceUsersSheetRows(rows);

    console.log(
      "[UsersSheetSync] Google Sheet replace completed",
      JSON.stringify({
        data_rows: rows.length,
        rows_with_square_team_id: rowsWithSquareTeamId,
        square_team_member_rows: squareFetched,
      })
    );

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

      const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
      console.log(
        "[UsersSheetSync] WordPress GET /wp/v2/users response",
        JSON.stringify({
          page,
          per_page: perPage,
          http_status: res.status,
          content_type: contentType.slice(0, 80),
        })
      );

      if (!res.ok) {
        const text = await res.text();
        console.error(
          "[UsersSheetSync] WordPress error body (truncated)",
          text.slice(0, 800)
        );
        throw new Error(
          `WordPress users fetch failed (${res.status}): ${text.slice(0, 500)}`
        );
      }

      const raw = await res.json();
      if (!Array.isArray(raw)) {
        console.error(
          "[UsersSheetSync] WordPress returned non-array JSON; type=",
          typeof raw,
          "keys=",
          raw && typeof raw === "object"
            ? Object.keys(raw as object).slice(0, 20)
            : []
        );
        throw new Error(
          "WordPress users response was not a JSON array (check REST URL, user capabilities, and application password)"
        );
      }
      const batch = raw as WpRestUser[];
      console.log(
        "[UsersSheetSync] WordPress users page parsed",
        JSON.stringify({
          page,
          batch_length: batch.length,
          running_total_after_page: all.length + batch.length,
        })
      );
      if (batch.length === 0) break;
      all.push(...batch);
      if (batch.length < perPage) break;
      page += 1;
    }

    return all;
  }
}
