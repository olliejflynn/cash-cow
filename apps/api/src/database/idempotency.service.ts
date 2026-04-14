import { Injectable } from "@nestjs/common";
import { claimEvent, type ClaimResult } from "@cash-cow/database";

@Injectable()
export class IdempotencyService {
  async claimEvent(
    eventId: string,
    source: string,
    orderId?: string | null
  ): Promise<ClaimResult> {
    return claimEvent(eventId, source, orderId);
  }
}
