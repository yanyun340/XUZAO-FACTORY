import type { NotificationCategory } from '../generated/prisma/enums.ts';

/**
 * 事件类型 → 业务分类。
 * 分类在写入时确定，查询时不再反推，避免以后改映射影响历史通知。
 */
const CATEGORY_BY_EVENT: Record<string, NotificationCategory> = {
  PURCHASE_CREATED: 'ORDER',
  ARRIVAL_RECORDED: 'ORDER',
  PRODUCTION_DISPATCHED: 'PRODUCTION',
  PRODUCTION_FEEDBACK: 'PRODUCTION',
  QC_DISPATCHED: 'QC',
  QC_RECORDED: 'QC',
  QC_PASSED: 'QC',
  PACKING_DISPATCHED: 'PACKING',
  PACKING_RECORDED: 'PACKING',
  SHIPPING_TRIGGERED: 'SHIPPING',
  SHIPMENT_RECORDED: 'SHIPPING',
  DUE_DATE_REMINDER: 'DUE_DATE',
  EXCEPTION_REPORTED: 'EXCEPTION',
  EXCEPTION_UPDATED: 'EXCEPTION',
};

export function categoryForEventType(eventType: string): NotificationCategory {
  return CATEGORY_BY_EVENT[eventType] ?? 'SYSTEM';
}

export const NOTIFICATION_CATEGORIES: readonly NotificationCategory[] = [
  'SYSTEM',
  'ORDER',
  'PRODUCTION',
  'QC',
  'PACKING',
  'SHIPPING',
  'INVENTORY',
  'EXCEPTION',
  'DUE_DATE',
] as const;