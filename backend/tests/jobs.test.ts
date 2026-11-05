import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/db.ts';
import { runDueDateReminders } from '../src/jobs/due-reminders.ts';
import { parseDateOnly, shanghaiDateKey } from '../src/lib/time.ts';
import { api, createApp, login, resetDb, seedBase, type Fixtures } from './helpers.ts';

let app: FastifyInstance;
let fx: Fixtures;
let admin: ReturnType<typeof api>;

const DAY_MS = 86_400_000;
const today = shanghaiDateKey();
const todayDate = parseDateOnly(today);

async function makeOrder(input: {
  orderNo: string;
  dueInDays: number;
  status?: 'PENDING_PURCHASE' | 'COMPLETED';
}) {
  return prisma.order.create({
    data: {
      orderNo: input.orderNo,
      customerId: fx.customerId,
      customerName: '测试客户',
      dueDate: new Date(todayDate.getTime() + input.dueInDays * DAY_MS),
      status: input.status ?? 'PENDING_PURCHASE',
      createdById: fx.users.admin,
      items: {
        create: [{ productName: '交期测试件', spec: 'A1', quantity: 10, unitPrice: '1.00' }],
      },
    },
  });
}

beforeAll(async () => {
  await resetDb();
  fx = await seedBase();
  app = await createApp();
  admin = api(app, await login(app, 'admin'));

  // 窗口内 1 单；窗口外 1 单；已完成 1 单
  await makeOrder({ orderNo: 'XZ-REMIND-1', dueInDays: 3 });
  await makeOrder({ orderNo: 'XZ-REMIND-2', dueInDays: 30 });
  await makeOrder({ orderNo: 'XZ-REMIND-3', dueInDays: 1, status: 'COMPLETED' });
});

afterAll(async () => {
  await app.close();
});

describe('交期提醒', () => {
  it('只提醒 7 天内未完成的订单，并且当天去重', async () => {
    const first = await runDueDateReminders();
    expect(first.businessDate).toBe(today);
    expect(first.orders).toBe(1);
    expect(first.recipients).toBe(1);
    expect(first.created).toBe(1);

    const second = await runDueDateReminders();
    expect(second.created).toBe(0);

    const rows = await prisma.notification.findMany({ where: { eventType: 'DUE_DATE_REMINDER' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.orderId).toBeTruthy();
    expect(rows[0]!.title).toContain('XZ-REMIND-1');
    expect(rows[0]!.title).toContain('3 天后到期');
    expect(rows[0]!.body).toContain('待采购');
  });

  it('管理员可通过接口手动补跑，普通角色不行', async () => {
    const manual = await admin('POST', '/api/v1/jobs/due-reminders');
    expect(manual.status).toBe(200);
    expect(manual.body.data.created).toBe(0);

    const logistics = api(app, await login(app, 'logistics'));
    expect((await logistics('POST', '/api/v1/jobs/due-reminders')).status).toBe(403);
  });

  it('通知支持未读筛选和一键已读', async () => {
    const unread = await admin('GET', '/api/v1/notifications?unread=true');
    expect(unread.status).toBe(200);
    expect(unread.body.meta.unread).toBe(1);
    expect(unread.body.data).toHaveLength(1);

    const readAll = await admin('POST', '/api/v1/notifications/read-all');
    expect(readAll.status).toBe(200);
    expect(readAll.body.data.updated).toBe(1);

    const after = await admin('GET', '/api/v1/notifications?unread=true');
    expect(after.body.meta.unread).toBe(0);
    expect(after.body.data).toHaveLength(0);

    const summary = await admin('GET', '/api/v1/notifications/summary');
    expect(summary.body.data).toEqual({ unread: 0, total: 1 });
  });
});