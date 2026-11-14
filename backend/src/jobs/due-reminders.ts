import { prisma } from '../db.ts';
import { STATUS_LABELS } from '../domain/orders.ts';
import { parseDateOnly, shanghaiDateKey, toDateOnly } from '../lib/time.ts';

export interface ReminderResult {
  businessDate: string;
  orders: number;
  recipients: number;
  created: number;
}

const REMINDER_WINDOW_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 交期提醒：交期在 7 天内（含当天）且未完成的订单，每天给管理员发一次。
 * dedupeKey 里带业务日期，所以同一天重复执行（开机补跑、手动触发）不会发第二条。
 */
export async function runDueDateReminders(now = new Date()): Promise<ReminderResult> {
  const businessDate = shanghaiDateKey(now);
  const today = parseDateOnly(businessDate);
  const horizon = new Date(today.getTime() + REMINDER_WINDOW_DAYS * DAY_MS);

  const [orders, admins] = await prisma.$transaction([
    prisma.order.findMany({
      where: {
        status: { not: 'COMPLETED' },
        dueDate: { gte: today, lte: horizon },
      },
      orderBy: [{ dueDate: 'asc' }, { id: 'asc' }],
      select: { id: true, orderNo: true, customerName: true, status: true, dueDate: true },
    }),
    prisma.adminUser.findMany({
      where: { active: true, role: 'ADMIN' },
      select: { id: true },
    }),
  ]);

  const rows = [];
  for (const order of orders) {
    const daysLeft = Math.round((order.dueDate.getTime() - today.getTime()) / DAY_MS);
    const when = daysLeft === 0 ? '今天到期' : `${daysLeft} 天后到期`;
    const statusLabel = STATUS_LABELS[order.status] ?? order.status;

    for (const admin of admins) {
      rows.push({
        eventType: 'DUE_DATE_REMINDER',
        category: 'DUE_DATE' as const,
        title: `交期提醒 · ${order.orderNo} ${when}`,
        body: `${order.customerName} 的订单交期为 ${toDateOnly(order.dueDate)}（${when}），当前状态：${statusLabel}。`,
        recipientId: admin.id,
        orderId: order.id,
        businessDate: today,
        dedupeKey: `due:${businessDate}:${order.id}:${admin.id}`,
      });
    }
  }

  const result =
    rows.length === 0
      ? { count: 0 }
      : await prisma.notification.createMany({ data: rows, skipDuplicates: true });

  return {
    businessDate,
    orders: orders.length,
    recipients: admins.length,
    created: result.count,
  };
}