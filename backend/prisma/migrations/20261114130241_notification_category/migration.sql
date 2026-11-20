-- CreateEnum
CREATE TYPE "NotificationCategory" AS ENUM ('SYSTEM', 'ORDER', 'PRODUCTION', 'QC', 'PACKING', 'SHIPPING', 'INVENTORY', 'EXCEPTION', 'DUE_DATE');

-- AlterTable
ALTER TABLE "notifications" ADD COLUMN     "category" "NotificationCategory" NOT NULL DEFAULT 'SYSTEM';

-- CreateIndex
CREATE INDEX "notifications_recipientId_category_readAt_idx" ON "notifications"("recipientId", "category", "readAt");
