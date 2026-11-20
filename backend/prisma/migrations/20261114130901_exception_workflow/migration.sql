-- AlterTable
ALTER TABLE "tablet_exceptions" ADD COLUMN     "category" TEXT NOT NULL DEFAULT 'OTHER',
ADD COLUMN     "expectedAt" TIMESTAMP(3),
ADD COLUMN     "handlerId" UUID,
ADD COLUMN     "resolution" TEXT,
ADD COLUMN     "resolvedAt" TIMESTAMP(3),
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateIndex
CREATE INDEX "tablet_exceptions_status_createdAt_idx" ON "tablet_exceptions"("status", "createdAt");

-- CreateIndex
CREATE INDEX "tablet_exceptions_handlerId_idx" ON "tablet_exceptions"("handlerId");

-- AddForeignKey
ALTER TABLE "tablet_exceptions" ADD CONSTRAINT "tablet_exceptions_handlerId_fkey" FOREIGN KEY ("handlerId") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
