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

    // 质量异常没有质检凭证时不能直接解决，必须先下发复核或显式留痕豁免
    const withoutQc = await admin('PATCH', `/api/v1/exceptions/${reported.body.data.id}`, {
      status: 'RESOLVED',
      resolution: '已更换刀具并复检',
    });
    expect(withoutQc.status).toBe(409);
    expect(withoutQc.body.error?.code).toBe('EXCEPTION_QC_REQUIRED');

    // 不能手填系统状态 WAITING_QC，绕开复核接口
    const fakeWaiting = await admin('PATCH', `/api/v1/exceptions/${reported.body.data.id}`, {
      status: 'WAITING_QC',
    });
    expect(fakeWaiting.status).toBe(409);
    expect(fakeWaiting.body.error?.code).toBe('EXCEPTION_REVIEW_REQUIRED');

    const resolved = await admin('PATCH', `/api/v1/exceptions/${reported.body.data.id}`, {
      status: 'RESOLVED',
      resolution: '已更换刀具并复检',
      waiveQc: true,
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

describe('异常下发复核（R22F × R09F）', () => {
  /** 一路推到「已生产、尚未首检」，返回生产任务与订单 ID。 */
  async function prepareProduced(): Promise<{
    orderId: string;
    productionId: string;
    admin: ReturnType<typeof api>;
    logistics: ReturnType<typeof api>;
    production: ReturnType<typeof api>;
    qc: ReturnType<typeof api>;
  }> {
    const adminCall = api(app, await login(app, 'admin'));
    const logisticsCall = api(app, await login(app, 'logistics'));
    const productionCall = api(app, await login(app, 'production'));
    const qcCall = api(app, await login(app, 'qc'));

    const order = await adminCall('POST', '/api/v1/orders', {
      customerId: fx.customerId,
      dueDate: '2026-12-31',
      items: [{ productName: '复核测试件', spec: 'B', quantity: 20, unitPrice: '2.00' }],
    });
    expect(order.status, JSON.stringify(order.body)).toBe(201);
    const orderId = order.body.data.id as string;

    const purchase = await adminCall('POST', `/api/v1/orders/${orderId}/purchase`, {
      supplierId: fx.supplierId,
      partId: fx.partId,
      quantity: 20,
      unitPrice: '1.00',
    });
    expect(purchase.status, JSON.stringify(purchase.body)).toBe(201);

    const arrival = await logisticsCall(
      'POST',
      `/api/v1/purchases/${purchase.body.data.flow.purchase.id}/arrivals`,
      { quantity: 20 },
    );
    expect(arrival.status, JSON.stringify(arrival.body)).toBe(201);

    const dispatched = await adminCall('POST', `/api/v1/orders/${orderId}/productions`, {
      departmentId: fx.departments.PROD,
      processName: '抛光',
      quantity: 20,
      unitPrice: '0.50',
    });
    expect(dispatched.status, JSON.stringify(dispatched.body)).toBe(201);
    const productionId = dispatched.body.data.flow.production.id as string;

    const feedback = await productionCall('POST', `/api/v1/productions/${productionId}/feedback`, {
      quantity: 20,
    });
    expect(feedback.status, JSON.stringify(feedback.body)).toBe(201);

    return {
      orderId,
      productionId,
      admin: adminCall,
      logistics: logisticsCall,
      production: productionCall,
      qc: qcCall,
    };
  }

  it('异常 → 下发复核 → 品控录入 → PASS → 才能标记解决', async () => {
    const ctx = await prepareProduced();
    expect(ctx.orderId).toBeTruthy();

    const reported = await ctx.production('POST', '/api/v1/exceptions', {
      productionOrderId: ctx.productionId,
      category: 'QUALITY',
      description: '配件表面有划痕，申请复核',
    });
    expect(reported.status).toBe(201);
    const exceptionId = reported.body.data.id as string;

    // 生产尚未反馈前的异常不能下发复核（此处已反馈，先验证未决策时不能重复下发）
    const review = await ctx.admin('POST', `/api/v1/exceptions/${exceptionId}/review`, {});
    expect(review.status, JSON.stringify(review.body)).toBe(200);
    expect(review.body.data).toMatchObject({ status: 'WAITING_QC', qcRecordId: null });

    const detail = await ctx.admin('GET', `/api/v1/orders/${ctx.orderId}`);
    expect(detail.body.data.status).toBe('PENDING_QC');

    // 品控队列收到复核通知
    const qcNotice = await prisma.notification.findFirst({
      where: { eventType: 'EXCEPTION_REVIEWED', recipientId: fx.users.qc },
    });
    expect(qcNotice).toBeTruthy();

    // 同一生产任务已有一张待复核异常时，第二张不能重复下发
    const second = await ctx.production('POST', '/api/v1/exceptions', {
      productionOrderId: ctx.productionId,
      category: 'QUALITY',
      description: '同一批次再次发现划痕',
    });
    const secondReview = await ctx.admin('POST', `/api/v1/exceptions/${second.body.data.id}/review`, {});
    expect(secondReview.status).toBe(409);
    expect(secondReview.body.error?.code).toBe('EXCEPTION_REVIEW_IN_PROGRESS');

    // 未取得 PASS 前不能标记解决
    const premature = await ctx.admin('PATCH', `/api/v1/exceptions/${exceptionId}`, {
      status: 'RESOLVED',
      resolution: '已复检',
    });
    expect(premature.status).toBe(409);
    expect(premature.body.error?.code).toBe('EXCEPTION_QC_REQUIRED');

    const record = await ctx.qc('POST', `/api/v1/productions/${ctx.productionId}/qc-records`, {
      inspectedQty: 20,
      qualifiedQty: 20,
      unqualifiedQty: 0,
    });
    expect(record.status, JSON.stringify(record.body)).toBe(201);
    const qcRecordId = record.body.data.flow.qc.id as string;

    // 录入后异常单自动关联质检记录，但结果未决策仍不能解决
    const linked = await ctx.admin('GET', `/api/v1/exceptions?status=WAITING_QC`);
    expect(linked.body.data[0]).toMatchObject({ id: exceptionId, qcRecordId });
    expect(linked.body.data[0].qc).toMatchObject({ recordId: qcRecordId, result: null });

    const notYetPassed = await ctx.admin('PATCH', `/api/v1/exceptions/${exceptionId}`, {
      status: 'RESOLVED',
      resolution: '已复检',
    });
    expect(notYetPassed.status).toBe(409);
    expect(notYetPassed.body.error?.code).toBe('EXCEPTION_QC_NOT_PASSED');

    const decision = await ctx.admin('POST', `/api/v1/qc-records/${qcRecordId}/decision`, {
      decision: 'PASS',
    });
    expect(decision.status).toBe(201);
    expect(decision.body.data.status).toBe('QC_DONE');

    const resolved = await ctx.admin('PATCH', `/api/v1/exceptions/${exceptionId}`, {
      status: 'RESOLVED',
      resolution: '复检全部合格，已放行 20 件',
    });
    expect(resolved.status).toBe(200);
    expect(resolved.body.data.status).toBe('RESOLVED');
    // 从 WAITING_QC 解决是合法迁移，不能被当成跳步拒绝
    expect(resolved.body.data.qcRecordId).toBe(qcRecordId);
    expect(resolved.body.data.qcWaived).toBe(false);
    expect(resolved.body.data.qc).toMatchObject({ result: 'PASS', releasedQty: 20 });

    const audit = await ctx.admin(
      'GET',
      `/api/v1/audit-logs?resourceId=${exceptionId}&pageSize=20`,
    );
    const actions = (audit.body.data as Array<{ action: string }>).map((row) => row.action);
    expect(actions).toContain('exception.review');
    expect(actions).toContain('exception.update');
  });

  it('首检判返工后，异常凭证跟随复检记录，直到复检 PASS 才能解决', async () => {
    const ctx = await prepareProduced();
    const reported = await ctx.production('POST', '/api/v1/exceptions', {
      productionOrderId: ctx.productionId,
      category: 'QUALITY',
      description: '表面划痕，需返工复检',
    });
    const exceptionId = reported.body.data.id as string;
    expect((await ctx.admin('POST', `/api/v1/exceptions/${exceptionId}/review`, {})).status).toBe(200);

    const initial = await ctx.qc('POST', `/api/v1/productions/${ctx.productionId}/qc-records`, {
      inspectedQty: 20,
      qualifiedQty: 18,
      unqualifiedQty: 2,
    });
    expect(initial.status, JSON.stringify(initial.body)).toBe(201);
    const initialId = initial.body.data.flow.qc.id as string;
    expect(
      (await ctx.admin('GET', '/api/v1/exceptions?status=WAITING_QC')).body.data[0].qcRecordId,
    ).toBe(initialId);

    const rework = await ctx.admin('POST', `/api/v1/qc-records/${initialId}/decision`, {
      decision: 'REWORK',
    });
    expect(rework.status).toBe(201);

    const reinspect = await ctx.qc('POST', `/api/v1/productions/${ctx.productionId}/qc-records`, {
      inspectedQty: 2,
      qualifiedQty: 2,
      unqualifiedQty: 0,
      parentQcRecordId: initialId,
    });
    expect(reinspect.status, JSON.stringify(reinspect.body)).toBe(201);
    const reinspectId = reinspect.body.data.flow.qc.id as string;

    const relinked = await ctx.admin('GET', '/api/v1/exceptions?status=WAITING_QC');
    expect(relinked.body.data[0].qcRecordId).toBe(reinspectId);
    expect(relinked.body.data[0].qc).toMatchObject({ round: 2, result: null });

    const pass = await ctx.admin('POST', `/api/v1/qc-records/${reinspectId}/decision`, {
      decision: 'PASS',
    });
    expect(pass.status).toBe(201);
    expect(pass.body.data.status).toBe('QC_DONE');

    const resolved = await ctx.admin('PATCH', `/api/v1/exceptions/${exceptionId}`, {
      status: 'RESOLVED',
      resolution: '返工复检合格，已放行 20 件',
    });
    expect(resolved.status).toBe(200);
    // 异常凭证是复检记录本身（放行 2 件）；订单累计放行量另在 quantities 里核对
    expect(resolved.body.data.qc).toMatchObject({ round: 2, result: 'PASS', releasedQty: 2 });
    const detail = await ctx.admin('GET', `/api/v1/orders/${ctx.orderId}`);
    expect(detail.body.data.flow.quantities).toMatchObject({
      releasedQty: 20,
      reworkPendingQty: 0,
    });
  });

  it('已首检且无返工量时，异常复核被拒绝并说明原因', async () => {
    const ctx = await prepareProduced();

    const dispatch = await ctx.admin('POST', `/api/v1/orders/${ctx.orderId}/qc-dispatch`);
    expect(dispatch.status).toBe(201);
    const record = await ctx.qc('POST', `/api/v1/productions/${ctx.productionId}/qc-records`, {
      inspectedQty: 20,
      qualifiedQty: 20,
      unqualifiedQty: 0,
    });
    expect(record.status).toBe(201);
    const decision = await ctx.admin(
      'POST',
      `/api/v1/qc-records/${record.body.data.flow.qc.id}/decision`,
      { decision: 'PASS' },
    );
    expect(decision.status).toBe(201);

    const reported = await ctx.production('POST', '/api/v1/exceptions', {
      productionOrderId: ctx.productionId,
      category: 'QUALITY',
      description: '包装前发现漆面瑕疵',
    });
    const review = await ctx.admin('POST', `/api/v1/exceptions/${reported.body.data.id}/review`, {});
    expect(review.status).toBe(422);
    expect(review.body.error?.code).toBe('EXCEPTION_NO_QC_BASIS');
  });

  it('未关联生产任务的异常不能下发复核，但可留痕解决', async () => {
    const adminCall = api(app, await login(app, 'admin'));
    const logisticsCall = api(app, await login(app, 'logistics'));

    const order = await adminCall('POST', '/api/v1/orders', {
      customerId: fx.customerId,
      dueDate: '2026-12-31',
      items: [{ productName: '无任务件', spec: 'C', quantity: 3, unitPrice: '1.00' }],
    });
    const reported = await logisticsCall('POST', '/api/v1/exceptions', {
      orderId: order.body.data.id,
      category: 'SCHEDULE',
      description: '交期临近，客户催单',
    });
    expect(reported.status).toBe(201);
    const exceptionId = reported.body.data.id as string;

    const review = await adminCall('POST', `/api/v1/exceptions/${exceptionId}/review`, {});
    expect(review.status).toBe(422);
    expect(review.body.error?.code).toBe('EXCEPTION_NO_PRODUCTION');

    // 非质量类异常不强制质检凭证（状态仍只能逐级推进）
    const started = await adminCall('PATCH', `/api/v1/exceptions/${exceptionId}`, {
      status: 'IN_PROGRESS',
      handlerId: fx.users.admin,
    });
    expect(started.status).toBe(200);

    const resolved = await adminCall('PATCH', `/api/v1/exceptions/${exceptionId}`, {
      status: 'RESOLVED',
      resolution: '已协调客户顺延两天',
    });
    expect(resolved.status).toBe(200);
    expect(resolved.body.data.qcWaived).toBe(false);
  });

  it('复核接口要求管理员权限且带幂等键', async () => {
    const ctx = await prepareProduced();
    const reported = await ctx.production('POST', '/api/v1/exceptions', {
      productionOrderId: ctx.productionId,
      category: 'QUALITY',
      description: '装配尺寸偏差',
    });
    const exceptionId = reported.body.data.id as string;

    const forbidden = await ctx.production(
      'POST',
      `/api/v1/exceptions/${exceptionId}/review`,
      {},
    );
    expect(forbidden.status).toBe(403);

    const key = 'review-key-0001';
    const first = await ctx.admin('POST', `/api/v1/exceptions/${exceptionId}/review`, {}, {
      'idempotency-key': key,
    });
    expect(first.status).toBe(200);

    const replay = await ctx.admin('POST', `/api/v1/exceptions/${exceptionId}/review`, {}, {
      'idempotency-key': key,
    });
    expect(replay.status).toBe(200);
    expect(replay.headers['idempotent-replayed']).toBe('true');
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
      completionPercent: '0.0',
    });
    expect(Array.isArray(dashboard.body.data.productionBoard)).toBe(true);

    // 口径：一位小数字符串；1 件应交、0 件已发 → "0.0"，不能是整数四舍五入的 0
    expect(dashboard.body.data.shipping.completionPercent).toBe('0.0');
    expect(typeof dashboard.body.data.shipping.completionPercent).toBe('string');

    const list = await admin('GET', `/api/v1/orders?ownerId=${ownerId}`);
    expect(list.status).toBe(200);
    expect(list.body.meta.total).toBe(1);
  });
});