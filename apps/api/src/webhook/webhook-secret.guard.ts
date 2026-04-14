import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  Logger,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Request } from "express";
import { createHmac, timingSafeEqual } from "crypto";

const WC_SIGNATURE_HEADER = "x-wc-webhook-signature";
const MAX_RAW_BODY_LOG = 3000;

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
  private readonly logger = new Logger(WebhookSecretGuard.name);

  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<Request & { rawBody?: Buffer }>();
    const secret = this.config.get<string>("webhookSecret");

    const headersForLog: Record<string, string> = {};
    for (const [k, v] of Object.entries(request.headers)) {
      if (v === undefined) continue;
      const val = Array.isArray(v) ? v.join(", ") : String(v);
      headersForLog[k] =
        k.toLowerCase() === WC_SIGNATURE_HEADER
          ? `[REDACTED, length=${val.length}]`
          : val;
    }
    this.logger.log(
      `Request headers: ${JSON.stringify(headersForLog, null, 2)}`
    );

    const contentType = request.headers["content-type"];
    this.logger.log(
      `Webhook received: WEBHOOK_SECRET configured=${!!secret} (length=${
        secret?.length ?? 0
      }), Content-Type=${contentType ?? "none"}`
    );

    if (!secret) {
      this.logger.log("No WEBHOOK_SECRET set – allowing request");
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
        this.logger.log(
          "Allowing WooCommerce test ping (form-urlencoded, no signature) – e.g. when saving the webhook"
        );
        return true;
      }
      const headerKeys = Object.keys(request.headers).filter((k) =>
        k.toLowerCase().includes("webhook")
      );
      this.logger.warn(
        `Signature verification failed: X-WC-Webhook-Signature missing or invalid. ` +
          `Header type=${typeof rawHeader}. Webhook-related headers: ${
            headerKeys.join(", ") || "none"
          }`
      );
      throw new UnauthorizedException("Missing X-WC-Webhook-Signature header");
    }

    const rawBody = request.rawBody;
    if (!rawBody || !Buffer.isBuffer(rawBody)) {
      this.logger.warn(
        `Signature verification failed: rawBody missing or not a Buffer (rawBody present=${!!rawBody}, isBuffer=${Buffer.isBuffer(
          rawBody
        )})`
      );
      throw new UnauthorizedException(
        "Missing body for signature verification"
      );
    }
    const rawBodyStr = rawBody.toString("utf8");
    const rawBodyLog =
      rawBodyStr.length <= MAX_RAW_BODY_LOG
        ? rawBodyStr
        : rawBodyStr.slice(0, MAX_RAW_BODY_LOG) +
          `\n...(truncated, total ${rawBody.length} bytes)`;
    this.logger.log(`Raw body length: ${rawBody.length} bytes`);
    this.logger.log(`Raw body (for signature verification):\n${rawBodyLog}`);
    const signatureTrimmed = signature.trim();
    this.logger.log(
      `X-WC-Webhook-Signature present, length=${signatureTrimmed.length}`
    );

    const expected = createHmac("sha256", secret)
      .update(rawBody)
      .digest("base64");
    const signatureBuffer = Buffer.from(signatureTrimmed, "utf8");
    const expectedBuffer = Buffer.from(expected, "utf8");

    if (signatureBuffer.length !== expectedBuffer.length) {
      this.logger.warn(
        `Signature verification failed: length mismatch. ` +
          `Expected length=${expectedBuffer.length}, received length=${signatureBuffer.length}`
      );
      throw new UnauthorizedException("Invalid webhook signature");
    }
    if (!timingSafeEqual(signatureBuffer, expectedBuffer)) {
      this.logger.warn(
        `Signature verification failed: HMAC mismatch (same length, different content). ` +
          `Check that the Secret in WooCommerce matches WEBHOOK_SECRET exactly (no extra spaces, same encoding).`
      );
      throw new UnauthorizedException("Invalid webhook signature");
    }

    this.logger.log("Webhook signature verified successfully");
    return true;
  }
}
