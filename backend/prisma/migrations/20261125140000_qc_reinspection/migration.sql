-- AlterTable
ALTER TABLE "qc_records" ADD COLUMN     "round" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "parentQcRecordId" UUID;

-- AlterTable
ALTER TABLE "qc_decisions" ADD COLUMN     "scrapQty" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "tablet_exceptions" ADD COLUMN     "qcRecordId" UUID,
ADD COLUMN     "qcWaived" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "qc_records_parentQcRecordId_idx" ON "qc_records"("parentQcRecordId");

-- CreateIndex
CREATE UNIQUE INDEX "tablet_exceptions_qcRecordId_key" ON "tablet_exceptions"("qcRecordId");

-- AddForeignKey
ALTER TABLE "qc_records" ADD CONSTRAINT "qc_records_parentQcRecordId_fkey" FOREIGN KEY ("parentQcRecordId") REFERENCES "qc_records"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tablet_exceptions" ADD CONSTRAINT "tablet_exceptions_qcRecordId_fkey" FOREIGN KEY ("qcRecordId") REFERENCES "qc_records"("id") ON DELETE SET NULL ON UPDATE CASCADE;