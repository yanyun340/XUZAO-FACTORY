/**
 * 备份/恢复共用的表清单。
 * 顺序即"父表在前"的插入顺序，恢复时按此顺序写回，避免外键报错。
 */

export const TABLES = [
  { name: 'departments', delegate: 'department' },
  { name: 'employees', delegate: 'employee' },
  { name: 'admin_users', delegate: 'adminUser' },
  { name: 'customers', delegate: 'customer' },
  { name: 'suppliers', delegate: 'supplier' },
  { name: 'parts', delegate: 'part' },
  { name: 'orders', delegate: 'order' },
  { name: 'order_items', delegate: 'orderItem' },
  { name: 'purchase_orders', delegate: 'purchaseOrder' },
  { name: 'purchase_items', delegate: 'purchaseItem' },
  { name: 'arrival_records', delegate: 'arrivalRecord' },
  { name: 'production_orders', delegate: 'productionOrder' },
  { name: 'production_feedbacks', delegate: 'productionFeedback' },
  // Prisma 只把首字母小写：QCRecord → qCRecord
  { name: 'qc_records', delegate: 'qCRecord' },
  { name: 'qc_decisions', delegate: 'qCDecision' },
  { name: 'packing_records', delegate: 'packingRecord' },
  { name: 'shipment_records', delegate: 'shipmentRecord' },
  { name: 'part_inventories', delegate: 'partInventory' },
  { name: 'product_inventories', delegate: 'productInventory' },
  { name: 'inventory_logs', delegate: 'inventoryLog' },
  { name: 'attachments', delegate: 'attachment' },
  { name: 'notifications', delegate: 'notification' },
  { name: 'audit_logs', delegate: 'auditLog' },
  { name: 'tablet_exceptions', delegate: 'tabletException' },
  { name: 'timeline_events', delegate: 'timelineEvent' },
  { name: 'idempotency_requests', delegate: 'idempotencyRequest' },
  { name: 'sequence_counters', delegate: 'sequenceCounter' },
  { name: 'sessions', delegate: 'session' },
] as const;

export type TableName = (typeof TABLES)[number]['name'];
export type DelegateName = (typeof TABLES)[number]['delegate'];

interface Delegate {
  findMany(args?: unknown): Promise<unknown[]>;
  createMany(args: { data: unknown[] }): Promise<{ count: number }>;
}

export type BackupDb = Record<DelegateName, Delegate>;

export const TABLE_NAMES: TableName[] = TABLES.map((table) => table.name);