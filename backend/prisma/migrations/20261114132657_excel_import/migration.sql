-- CreateEnum
CREATE TYPE "ImportEntity" AS ENUM ('CUSTOMER', 'SUPPLIER', 'PART', 'EMPLOYEE');

-- CreateTable
CREATE TABLE "import_batches" (
    "id" UUID NOT NULL,
    "entity" "ImportEntity" NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PREFLIGHTED',
    "fileName" TEXT NOT NULL,
    "rowCount" INTEGER NOT NULL,
    "errorCount" INTEGER NOT NULL DEFAULT 0,
    "errors" JSONB,
    "rows" JSONB,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "committedAt" TIMESTAMP(3),

    CONSTRAINT "import_batches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "import_batches_entity_createdAt_idx" ON "import_batches"("entity", "createdAt");

-- AddForeignKey
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
