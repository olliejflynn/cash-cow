-- CreateTable
CREATE TABLE "square_oauth_credentials" (
    "id" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "token_ciphertext" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "square_oauth_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "square_oauth_credentials_merchant_id_environment_key" ON "square_oauth_credentials"("merchant_id", "environment");
