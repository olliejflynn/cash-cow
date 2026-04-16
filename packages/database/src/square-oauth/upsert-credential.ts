import { getPrismaClient } from "../idempotency/client";

export async function upsertSquareOAuthCredential(input: {
  environment: string;
  merchantId: string;
  tokenCiphertext: string;
  expiresAt: Date | null;
}): Promise<void> {
  const prisma = getPrismaClient();
  await prisma.squareOAuthCredential.upsert({
    where: {
      merchantId_environment: {
        merchantId: input.merchantId,
        environment: input.environment,
      },
    },
    create: {
      environment: input.environment,
      merchantId: input.merchantId,
      tokenCiphertext: input.tokenCiphertext,
      expiresAt: input.expiresAt ?? undefined,
    },
    update: {
      tokenCiphertext: input.tokenCiphertext,
      expiresAt: input.expiresAt ?? undefined,
    },
  });
}
