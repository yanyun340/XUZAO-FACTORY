-- CreateEnum
CREATE TYPE "SupplierType" AS ENUM ('NORMAL', 'ELECTROPLATING');

-- AlterTable
ALTER TABLE "suppliers" ADD COLUMN     "type" "SupplierType" NOT NULL DEFAULT 'NORMAL';

-- CreateTable
CREATE TABLE "part_suppliers" (
    "id" UUID NOT NULL,
    "partId" UUID NOT NULL,
    "supplierId" UUID NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "part_suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "part_suppliers_partId_isDefault_idx" ON "part_suppliers"("partId", "isDefault");

-- CreateIndex
CREATE UNIQUE INDEX "part_suppliers_partId_supplierId_key" ON "part_suppliers"("partId", "supplierId");

-- AddForeignKey
ALTER TABLE "part_suppliers" ADD CONSTRAINT "part_suppliers_partId_fkey" FOREIGN KEY ("partId") REFERENCES "parts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "part_suppliers" ADD CONSTRAINT "part_suppliers_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 同一配件至多一个默认供应商；并发设置时由数据库兜底。
CREATE UNIQUE INDEX "part_suppliers_one_default_per_part"
  ON "part_suppliers"("partId") WHERE "isDefault" = true;
