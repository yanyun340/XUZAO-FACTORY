-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "ownerId" UUID;

-- 历史订单没有负责人，回填为创建人，保证筛选口径不为空。
UPDATE "orders" SET "ownerId" = "createdById" WHERE "ownerId" IS NULL;

-- CreateIndex
CREATE INDEX "orders_ownerId_createdAt_idx" ON "orders"("ownerId", "createdAt");

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
