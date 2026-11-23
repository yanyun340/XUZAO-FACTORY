-- CreateEnum
CREATE TYPE "PlatingStatus" AS ENUM ('PENDING', 'SENT', 'RECEIVED');

-- CreateTable
CREATE TABLE "plating_orders" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "purchaseItemId" UUID NOT NULL,
    "supplierId" UUID NOT NULL,
    "supplierName" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPrice" DECIMAL(12,2) NOT NULL,
    "status" "PlatingStatus" NOT NULL DEFAULT 'PENDING',
    "createdById" UUID NOT NULL,
    "sentById" UUID,
    "sentAt" TIMESTAMP(3),
    "receivedById" UUID,
    "receivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plating_orders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "plating_orders_orderId_idx" ON "plating_orders"("orderId");

-- CreateIndex
CREATE INDEX "plating_orders_purchaseItemId_idx" ON "plating_orders"("purchaseItemId");

-- AddForeignKey
ALTER TABLE "plating_orders" ADD CONSTRAINT "plating_orders_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plating_orders" ADD CONSTRAINT "plating_orders_purchaseItemId_fkey" FOREIGN KEY ("purchaseItemId") REFERENCES "purchase_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plating_orders" ADD CONSTRAINT "plating_orders_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plating_orders" ADD CONSTRAINT "plating_orders_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plating_orders" ADD CONSTRAINT "plating_orders_sentById_fkey" FOREIGN KEY ("sentById") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plating_orders" ADD CONSTRAINT "plating_orders_receivedById_fkey" FOREIGN KEY ("receivedById") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
