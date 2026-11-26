-- AlterTable
ALTER TABLE "arrival_records" ADD COLUMN     "voidReason" TEXT,
ADD COLUMN     "voidedAt" TIMESTAMP(3),
ADD COLUMN     "voidedById" UUID;

-- AlterTable
ALTER TABLE "packing_records" ADD COLUMN     "voidReason" TEXT,
ADD COLUMN     "voidedAt" TIMESTAMP(3),
ADD COLUMN     "voidedById" UUID;

-- AlterTable
ALTER TABLE "production_feedbacks" ADD COLUMN     "voidReason" TEXT,
ADD COLUMN     "voidedAt" TIMESTAMP(3),
ADD COLUMN     "voidedById" UUID;

-- AlterTable
ALTER TABLE "qc_decisions" ADD COLUMN     "voidReason" TEXT,
ADD COLUMN     "voidedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "qc_records" ADD COLUMN     "voidReason" TEXT,
ADD COLUMN     "voidedAt" TIMESTAMP(3),
ADD COLUMN     "voidedById" UUID;

-- AlterTable
ALTER TABLE "shipment_records" ADD COLUMN     "voidReason" TEXT,
ADD COLUMN     "voidedAt" TIMESTAMP(3),
ADD COLUMN     "voidedById" UUID;

-- CreateIndex
CREATE INDEX "arrival_records_voidedAt_idx" ON "arrival_records"("voidedAt");

-- CreateIndex
CREATE INDEX "packing_records_voidedAt_idx" ON "packing_records"("voidedAt");

-- CreateIndex
CREATE INDEX "production_feedbacks_voidedAt_idx" ON "production_feedbacks"("voidedAt");

-- CreateIndex
CREATE INDEX "qc_decisions_voidedAt_idx" ON "qc_decisions"("voidedAt");

-- CreateIndex
CREATE INDEX "qc_records_voidedAt_idx" ON "qc_records"("voidedAt");

-- CreateIndex
CREATE INDEX "shipment_records_voidedAt_idx" ON "shipment_records"("voidedAt");

-- AddForeignKey
ALTER TABLE "arrival_records" ADD CONSTRAINT "arrival_records_voidedById_fkey" FOREIGN KEY ("voidedById") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_feedbacks" ADD CONSTRAINT "production_feedbacks_voidedById_fkey" FOREIGN KEY ("voidedById") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qc_records" ADD CONSTRAINT "qc_records_voidedById_fkey" FOREIGN KEY ("voidedById") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "packing_records" ADD CONSTRAINT "packing_records_voidedById_fkey" FOREIGN KEY ("voidedById") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_records" ADD CONSTRAINT "shipment_records_voidedById_fkey" FOREIGN KEY ("voidedById") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
