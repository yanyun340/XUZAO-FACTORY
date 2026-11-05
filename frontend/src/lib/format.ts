import type { OrderStatus, Role } from '../api/types';

export const STATUS_META: Record<OrderStatus, { label: string; tone: string; short: string }> = {
  PENDING_PURCHASE: { label: '待采购', tone: 'amber', short: '待采购' },
  PURCHASING: { label: '采购中', tone: 'amber', short: '采购中' },
  IN_PRODUCTION: { label: '生产中', tone: 'blue', short: '生产中' },
  PENDING_QC: { label: '待质检', tone: 'violet', short: '待质检' },
  QC_DONE: { label: '质检完成', tone: 'teal', short: '质检完成' },
  PACKING: { label: '包装中', tone: 'cyan', short: '包装中' },
  SHIPPING: { label: '发货中', tone: 'orange', short: '发货中' },
  COMPLETED: { label: '已完成', tone: 'green', short: '已完成' },
};

export const STATUS_FLOW: OrderStatus[] = [
  'PENDING_PURCHASE',
  'PURCHASING',
  'IN_PRODUCTION',
  'PENDING_QC',
  'QC_DONE',
  'PACKING',
  'SHIPPING',
  'COMPLETED',
];

export const ROLE_LABEL: Record<Role, string> = {
  ADMIN: '管理员',
  LOGISTICS: '物流',
  PRODUCTION: '生产',
  QC: '品控',
  PACKING: '包装',
};

/** 时间线事件的中文名，订单详情与通知中心共用。 */
export const EVENT_LABEL: Record<string, string> = {
  ORDER_CREATED: '订单创建',
  PURCHASE_CREATED: '创建采购单',
  ARRIVAL_RECORDED: '登记到货',
  PRODUCTION_DISPATCHED: '下发生产',
  PRODUCTION_FEEDBACK: '生产反馈',
  QC_DISPATCHED: '下发质检',
  QC_RECORDED: '质检录入',
  QC_PASSED: '质检放行',
  PACKING_DISPATCHED: '下发包装',
  PACKING_RECORDED: '包装登记',
  SHIPPING_TRIGGERED: '触发发货',
  SHIPMENT_RECORDED: '发货登记',
  DUE_DATE_REMINDER: '交期提醒',
};

export function eventLabel(type: string): string {
  return EVENT_LABEL[type] ?? type;
}

/** 审计动作的中文名，审计日志页使用；未登记的动作回退成原始 code。 */
export const AUDIT_ACTION_LABEL: Record<string, string> = {
  'auth.login': '登录',
  'auth.logout': '退出登录',
  'order.create': '创建订单',
  'purchase.create': '创建采购单',
  'arrival.create': '登记到货',
  'production.dispatch': '下发生产',
  'production.feedback': '生产反馈',
  'qc.dispatch': '下发质检',
  'qc.record': '录入质检',
  'qc.decide': '质检放行',
  'packing.dispatch': '下发包装',
  'packing.record': '包装登记',
  'shipping.trigger': '触发发货',
  'shipment.record': '发货登记',
  'inventory.part.adjust': '配件库存调整',
  'inventory.product.adjust': '商品库存调整',
  'inventory.product.create': '新建商品库存',
  'attachment.upload': '上传附件',
  'exception.report': '上报异常',
  'customer.create': '新建客户',
  'supplier.create': '新建供应商',
  'part.create': '新建配件',
  'department.create': '新建部门',
  'employee.create': '新建员工',
};

export function auditActionLabel(action: string): string {
  return AUDIT_ACTION_LABEL[action] ?? action;
}

export const AUDIT_RESOURCE_LABEL: Record<string, string> = {
  auth: '登录会话',
  order: '订单',
  purchase: '采购单',
  arrival: '到货',
  production: '生产任务',
  qc: '质检记录',
  qc_decision: '质检放行',
  packing: '包装',
  shipment: '发货',
  part_inventory: '配件库存',
  product_inventory: '商品库存',
  attachment: '附件',
  exception: '异常',
  customer: '客户',
  supplier: '供应商',
  part: '配件',
  department: '部门',
  employee: '员工',
};

export function auditResourceLabel(type: string): string {
  return AUDIT_RESOURCE_LABEL[type] ?? type;
}

export const STATUS_OPTIONS = (Object.keys(STATUS_META) as OrderStatus[]).map((value) => ({
  value,
  label: STATUS_META[value].label,
}));

const moneyFormatter = new Intl.NumberFormat('zh-CN', {
  style: 'currency',
  currency: 'CNY',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatMoney(value: string | null): string {
  if (value === null) return '—';
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return value;
  return moneyFormatter.format(numeric).replace('CN¥', '¥');
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat('zh-CN').format(value);
}

export function formatDateOnly(value: string): string {
  return value.replaceAll('-', '.');
}

export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}.${get('month')}.${get('day')} ${get('hour')}:${get('minute')}`;
}

export function todayDateInput(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function dueHint(dueDate: string): { text: string; tone: 'normal' | 'soon' | 'overdue' } {
  const today = todayDateInput();
  const todayTime = Date.parse(`${today}T00:00:00Z`);
  const dueTime = Date.parse(`${dueDate}T00:00:00Z`);
  const days = Math.round((dueTime - todayTime) / 86_400_000);

  if (days < 0) return { text: `已逾期 ${Math.abs(days)} 天`, tone: 'overdue' };
  if (days === 0) return { text: '今天到期', tone: 'soon' };
  if (days <= 7) return { text: `剩余 ${days} 天`, tone: 'soon' };
  return { text: `剩余 ${days} 天`, tone: 'normal' };
}

export function currentStageIndex(status: OrderStatus): number {
  return STATUS_FLOW.indexOf(status);
}

export function greeting(): string {
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Shanghai',
      hour: '2-digit',
      hour12: false,
    }).format(new Date()),
  );
  if (hour < 6) return '夜深了';
  if (hour < 11) return '早上好';
  if (hour < 13) return '中午好';
  if (hour < 18) return '下午好';
  return '晚上好';
}