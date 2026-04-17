import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Request } from "express";
import { createHmac, timingSafeEqual } from "crypto";

const WC_SIGNATURE_HEADER = "x-wc-webhook-signature";

/** WooCommerce sends a form-urlencoded test ping when you save the webhook (no signature). */
function isWooCommerceTestPing(request: Request): boolean {
  const ct = request.headers["content-type"];
  const type = typeof ct === "string" ? ct : Array.isArray(ct) ? ct[0] : "";
  if (!type.toLowerCase().includes("application/x-www-form-urlencoded"))
    return false;
  const cl = request.headers["content-length"];
  const len =
    typeof cl === "string"
      ? parseInt(cl, 10)
      : Array.isArray(cl)
        ? parseInt(cl[0], 10)
        : NaN;
  return !isNaN(len) && len <= 100;
}

@Injectable()
export class WebhookSecretGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<Request & { rawBody?: Buffer }>();
    const secret = this.config.get<string>("webhookSecret");

    if (!secret) {
      console.log(
        `[WooWebhook][Guard] WEBHOOK_SECRET not set; allowing request ${request.method} ${request.originalUrl ?? request.url}`
      );
      return true;
    }

    const rawHeader = request.headers[WC_SIGNATURE_HEADER];
    const signature =
      typeof rawHeader === "string"
        ? rawHeader
        : Array.isArray(rawHeader)
          ? rawHeader[0]
          : undefined;

    if (!signature || typeof signature !== "string") {
      if (isWooCommerceTestPing(request)) {
        console.log(
          "[WooWebhook][Guard] Allowing unsigned WooCommerce test ping"
        );
        return true;
      }
      console.warn(
        `[WooWebhook][Guard] Rejecting request without ${WC_SIGNATURE_HEADER} header`
      );
      throw new UnauthorizedException("Missing X-WC-Webhook-Signature header");
    }

    const rawBody = request.rawBody;
    if (!rawBody || !Buffer.isBuffer(rawBody)) {
      console.warn(
        "[WooWebhook][Guard] Rejecting request: rawBody unavailable for signature verification"
      );
      throw new UnauthorizedException(
        "Missing body for signature verification"
      );
    }

    const signatureTrimmed = signature.trim();
    const expected = createHmac("sha256", secret)
      .update(rawBody)
      .digest("base64");
    const signatureBuffer = Buffer.from(signatureTrimmed, "utf8");
    const expectedBuffer = Buffer.from(expected, "utf8");

    if (signatureBuffer.length !== expectedBuffer.length) {
      console.warn(
        `[WooWebhook][Guard] Rejecting request: signature length mismatch (got=${signatureBuffer.length}, expected=${expectedBuffer.length})`
      );
      throw new UnauthorizedException("Invalid webhook signature");
    }
    if (!timingSafeEqual(signatureBuffer, expectedBuffer)) {
      console.warn("[WooWebhook][Guard] Rejecting request: signature mismatch");
      throw new UnauthorizedException("Invalid webhook signature");
    }

    console.log("[WooWebhook][Guard] Signature verified");
    return true;
  }
}
