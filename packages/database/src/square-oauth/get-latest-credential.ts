import { getPrismaClient } from "../idempotency/client";

export interface SquareOAuthCredentialRecord {
  environment: string;
  merchantId: string;
  tokenCiphertext: string;
  updatedAt: Date;
}

export async function getLatestSquareOAuthCredential(
  environment: string
): Promise<SquareOAuthCredentialRecord | null> {
  const prisma = getPrismaClient();
  const credential = await prisma.squareOAuthCredential.findFirst({
    where: { environment },
    orderBy: { updatedAt: "desc" },
    select: {
      environment: true,
      merchantId: true,
      tokenCiphertext: true,
      updatedAt: true,
    },
  });

  if (!credential) return null;
  return credential;
}
