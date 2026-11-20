import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/db.ts';
import { categoryForEventType } from '../src/lib/notification-categories.ts';
import { api, createApp, login, resetDb, seedBase, type Fixtures } from './helpers.ts';

let app: FastifyInstance;
let fx: Fixtures;

beforeAll(async () => {
  await resetDb();
  fx = await seedBase();
  app = await createApp();
});

afterAll(async () => {
  await app.close();
});

describe('看板字段级脱敏', () => {
  it('管理员能看到利润明细', async () => {
    const response = await api(app, await login(app, 'admin'))('GET', '/api/v1/dashboard');
    expect(response.status).toBe(200);
    expect(response.body.data.profit).toMatchObject({
      sales: '0.00',
      purchaseCost: '0.00',
      productionCost: '0.00',
      profit: '0.00',
    });
  });

  it.each(['logistics', 'production', 'qc', 'packing'])(
    '%s 的看板不返回任何金额字段',
    async (username) => {
      const response = await api(app, await login(app, username))('GET', '/api/v1/dashboard');
      expect(response.status).toBe(200);
      expect(response.body.data.profit).toBeNull();
    },
  );
});

describe('通知业务分类（R20F）', () => {
  it('按分类过滤，并在 summary 中返回分类计数', async () => {
    const admin = await prisma.adminUser.findUniqueOrThrow({ where: { username: 'admin' } });
    await prisma.notification.createMany({
      data: [
        {
          eventType: 'PURCHASE_CREATED',
          category: 'ORDER',
          title: '订单事件',
          body: '订单事件正文',
          recipientId: admin.id,
          dedupeKey: 'test:category:order',
        },
        {
          eventType: 'PRODUCTION_FEEDBACK',
          category: 'PRODUCTION',
          title: '生产事件',
          body: '生产事件正文',
          recipientId: admin.id,
          dedupeKey: 'test:category:production',
        },
        {
          eventType: 'QC_PASSED',
          category: 'QC',
          title: '质检事件',
          body: '质检事件正文',
          recipientId: admin.id,
          dedupeKey: 'test:category:qc',
        },
      ],
    });

    const cookie = await login(app, 'admin');
    const filtered = await api(app, cookie)('GET', '/api/v1/notifications?category=PRODUCTION');
    expect(filtered.status).toBe(200);
    expect(filtered.body.data).toHaveLength(1);
    expect(filtered.body.data[0]).toMatchObject({ category: 'PRODUCTION', title: '生产事件' });

    const summary = await api(app, cookie)('GET', '/api/v1/notifications/summary');
    expect(summary.body.data.unread).toBe(3);
    expect(summary.body.data.byCategory.PRODUCTION).toEqual({ total: 1, unread: 1 });
    expect(summary.body.data.byCategory.ORDER).toEqual({ total: 1, unread: 1 });
    expect(summary.body.data.byCategory.EXCEPTION).toEqual({ total: 0, unread: 0 });
  });

  it('事件类型映射到固定分类，未知事件回退 SYSTEM', () => {
    expect(categoryForEventType('PURCHASE_CREATED')).toBe('ORDER');
    expect(categoryForEventType('QC_PASSED')).toBe('QC');
    expect(categoryForEventType('DUE_DATE_REMINDER')).toBe('DUE_DATE');
    expect(categoryForEventType('SOMETHING_NEW')).toBe('SYSTEM');
  });
});

describe('异常处置（R22F）', () => {
  it('上报 → 处理中 → 解决，状态、处理人、时间与通知都可核对', async () => {
    const admin = api(app, await login(app, 'admin'));
    const order = await admin('POST', '/api/v1/orders', {
      customerId: fx.customerId,
      dueDate: '2026-12-31',
      items: [{ productName: '异常测试件', spec: 'A', quantity: 10, unitPrice: '1.00' }],
    });
    expect(order.status).toBe(201);
    const orderId = order.body.data.id;

    const logistics = api(app, await login(app, 'logistics'));
    const reported = await logistics('POST', '/api/v1/exceptions', {
      orderId,
      category: 'QUALITY',
      description: '尺寸偏差，无法装配',
    });
    expect(reported.status).toBe(201);
    expect(reported.body.data).toMatchObject({ category: 'QUALITY', status: 'OPEN' });

    const adminNotification = await prisma.notification.findFirst({
      where: { eventType: 'EXCEPTION_REPORTED', category: 'EXCEPTION' },
    });
    expect(adminNotification).toBeTruthy();

    const filtered = await admin('GET', '/api/v1/exceptions?status=OPEN&category=QUALITY');
    expect(filtered.status).toBe(200);
    expect(filtered.body.data).toHaveLength(1);

    const started = await admin('PATCH', `/api/v1/exceptions/${reported.body.data.id}`, {
      status: 'IN_PROGRESS',
      handlerId: fx.users.admin,
      expectedAt: '2026-11-20T10:00:00+08:00',
    });
    expect(started.status).toBe(200);
    expect(started.body.data).toMatchObject({
      status: 'IN_PROGRESS',
      handlerId: fx.users.admin,
    });
    expect(started.body.data.expectedAt).toBeTruthy();

    const backwards = await admin('PATCH', `/api/v1/exceptions/${reported.body.data.id}`, {
      status: 'OPEN',
    });
    expect(backwards.status).toBe(409);
    expect(backwards.body.error?.code).toBe('EXCEPTION_STATUS_CONFLICT');

    const missingResolution = await admin('PATCH', `/api/v1/exceptions/${reported.body.data.id}`, {
      status: 'RESOLVED',
    });
    expect(missingResolution.status).toBe(400);

    const resolved = await admin('PATCH', `/api/v1/exceptions/${reported.body.data.id}`, {
      status: 'RESOLVED',
      resolution: '已更换刀具并复检',
    });
    expect(resolved.status).toBe(200);
    expect(resolved.body.data.status).toBe('RESOLVED');
    expect(resolved.body.data.resolvedAt).toBeTruthy();

    const reporterNotification = await prisma.notification.findFirst({
      where: {
        eventType: 'EXCEPTION_UPDATED',
        recipientId: fx.users.logistics,
        category: 'EXCEPTION',
      },
    });
    expect(reporterNotification).toBeTruthy();

    const nonAdmin = await logistics('PATCH', `/api/v1/exceptions/${reported.body.data.id}`, {
      status: 'CLOSED',
    });
    expect(nonAdmin.status).toBe(403);
  });
});

describe('看板筛选与指标（R21F）', () => {
  it('负责人筛选与订单列表一致，且返回生产/库存/发货指标', async () => {
    const admin = api(app, await login(app, 'admin'));

    const secondAdmin = await admin('POST', '/api/v1/users', {
      username: 'dashboard-owner',
      password: 'Owner-pass-2026',
      displayName: '看板负责人',
      role: 'ADMIN',
      departmentId: null,
    });
    expect(secondAdmin.status).toBe(201);
    const ownerId = secondAdmin.body.data.id;

    const created = await admin('POST', '/api/v1/orders', {
      customerId: fx.customerId,
      dueDate: '2026-12-31',
      ownerId,
      items: [{ productName: '看板筛选件', spec: 'D-01', quantity: 5, unitPrice: '9.90' }],
    });
    expect(created.status).toBe(201);

    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(
      new Date(),
    );
    const dashboard = await admin(
      'GET',
      `/api/v1/dashboard?ownerId=${ownerId}&from=${today}&to=${today}`,
    );
    expect(dashboard.status).toBe(200);
    expect(dashboard.body.data.totalOrders).toBe(1);
    expect(dashboard.body.data.filters).toMatchObject({ ownerId, from: today, to: today });
    expect(dashboard.body.data.recentOrders).toHaveLength(1);
    expect(dashboard.body.data.recentOrders[0].ownerId).toBe(ownerId);
    expect(dashboard.body.data.inventory).toMatchObject({
      parts: expect.any(Number),
      products: expect.any(Number),
    });
    expect(dashboard.body.data.shipping).toMatchObject({
      orderQty: 5,
      shippedQty: 0,
      completionPercent: 0,
    });
    expect(Array.isArray(dashboard.body.data.productionBoard)).toBe(true);

    const list = await admin('GET', `/api/v1/orders?ownerId=${ownerId}`);
    expect(list.status).toBe(200);
    expect(list.body.meta.total).toBe(1);
  });
});