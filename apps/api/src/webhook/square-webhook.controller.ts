import { Body, Controller, HttpCode, Post } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SheetsService } from "../sheets/sheets.service";
import { SquareOAuthService } from "../square-oauth/square-oauth.service";
import type { SquarePaymentRow } from "./square-payment.types";

@Controller("webhooks/square")
export class SquareWebhookController {
  constructor(
    private readonly sheetsService: SheetsService,
    private readonly squareOAuthService: SquareOAuthService,
    private readonly config: ConfigService
  ) {}

  @Post("payment")
  @HttpCode(200)
  async handlePaymentWebhook(@Body() body: unknown): Promise<{ ok: boolean }> {
    const payload = isRecord(body) ? body : {};
    const payment = getPaymentObject(payload);
    const merchantId = getMerchantId(payload, payment);
    const primaryMerchantId = (
      this.config.get<string>("squarePrimaryMerchantId") ?? ""
    ).trim();
    const mMerchantId = (this.config.get<string>("squareMMerchantId") ?? "").trim();
    const amount =
      getNumericField(getNestedRecord(payment, "amount_money"), "amount") ??
      getNumericField(getNestedRecord(payment, "total_money"), "amount");
    const status = (getStringField(payment, "status") ?? "").trim();
    const paymentId = (getStringField(payment, "id") ?? "").trim();
    const row: SquarePaymentRow = {
      payment_id: paymentId,
      payment_time:
        getStringField(payment, "updated_at") ??
        getStringField(payment, "created_at") ??
        "",
      team_member: getStringField(payment, "team_member_id") ?? "",
      seller_id: "",
      amount_cents: amount == null ? "" : String(amount),
      status,
    };

    if (status.toUpperCase() !== "COMPLETED") {
      return { ok: true };
    }

    if (paymentId === "" || row.team_member.trim() === "") {
      return { ok: true };
    }

    const route = resolveMerchantRoute({
      merchantId,
      primaryMerchantId,
      mMerchantId,
    });
    if (route === "unmapped") {
      console.warn(
        "[SquareWebhook] Skipping payload for unmapped merchant",
        JSON.stringify({ merchant_id: merchantId, payment_id: paymentId })
      );
      return { ok: true };
    }

    const alreadyInSheet =
      route === "primary"
        ? await this.sheetsService.squarePaymentIdExists(paymentId)
        : await this.sheetsService.mSquarePaymentIdExists(paymentId);
    if (alreadyInSheet) {
      return { ok: true };
    }

    const sellerId =
      route === "primary"
        ? await this.sheetsService.getSellerIdBySquareTeamMemberId(row.team_member)
        : await this.lookupSellerIdByMSquareTeamMemberId(row.team_member);
    if (sellerId == null) {
      return { ok: true };
    }

    row.seller_id = String(sellerId);

    console.log(
      JSON.stringify({
        payment_id: row.payment_id,
        team_member: row.team_member,
        seller_id: row.seller_id,
        amount_cents: row.amount_cents,
        status: row.status,
        merchant_id: merchantId,
        route,
      })
    );

    if (route === "primary") {
      await this.sheetsService.appendSquarePaymentRows([row]);
    } else {
      await this.sheetsService.appendMSquarePaymentRows([row]);
    }

    return { ok: true };
  }

  private async lookupSellerIdByMSquareTeamMemberId(
    teamMemberId: string
  ): Promise<number | null> {
    const { emailByTeamId } =
      await this.squareOAuthService.fetchTeamMemberEmailByIdMap("m");
    const sellerEmail = emailByTeamId.get(teamMemberId.trim()) ?? "";
    if (sellerEmail === "") return null;
    return this.sheetsService.getSellerIdByEmail(sellerEmail);
  }
}

type SquareMerchantRoute = "primary" | "m" | "unmapped";

function resolveMerchantRoute(input: {
  merchantId: string;
  primaryMerchantId: string;
  mMerchantId: string;
}): SquareMerchantRoute {
  const merchantId = input.merchantId.trim();
  if (merchantId === "") return "unmapped";
  if (input.primaryMerchantId !== "" && merchantId === input.primaryMerchantId) {
    return "primary";
  }
  if (input.mMerchantId !== "" && merchantId === input.mMerchantId) {
    return "m";
  }
  return "unmapped";
}

function getPaymentObject(payload: Record<string, unknown>): Record<string, unknown> {
  const data = getNestedRecord(payload, "data");
  const object = getNestedRecord(data, "object");
  return getNestedRecord(object, "payment");
}

function getMerchantId(
  payload: Record<string, unknown>,
  payment: Record<string, unknown>
): string {
  const direct = (getStringField(payload, "merchant_id") ?? "").trim();
  if (direct !== "") return direct;
  const fromPayment = (getStringField(payment, "merchant_id") ?? "").trim();
  if (fromPayment !== "") return fromPayment;
  const fromData = (getStringField(getNestedRecord(payload, "data"), "merchant_id") ?? "").trim();
  return fromData;
}

function getNestedRecord(
  source: Record<string, unknown>,
  key: string
): Record<string, unknown> {
  const value = source[key];
  return isRecord(value) ? value : {};
}

function getStringField(
  source: Record<string, unknown>,
  key: string
): string | undefined {
  const value = source[key];
  return typeof value === "string" ? value : undefined;
}

function getNumericField(
  source: Record<string, unknown>,
  key: string
): number | undefined {
  const value = source[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}
