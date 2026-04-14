import { getPrismaClient } from "./client";

export interface ClaimResult {
  claimed: boolean;
}

/**
 * Attempt to claim a webhook event for processing. If the event_id was already
 * seen, returns { claimed: false }. On successful insert, returns { claimed: true }.
 */
export async function claimEvent(
  eventId: string,
  source: string,
  orderId?: string | null
): Promise<ClaimResult> {
  const prisma = getPrismaClient();
  try {
    await prisma.webhookEvent.create({
      data: {
        eventId,
        source,
        orderId: orderId ?? undefined,
      },
    });
    return { claimed: true };
  } catch (e: unknown) {
    const isUniqueViolation =
      e &&
      typeof e === "object" &&
      "code" in e &&
      (e as { code: string }).code === "P2002";
    if (isUniqueViolation) {
      return { claimed: false };
    }
    throw e;
  }
}
