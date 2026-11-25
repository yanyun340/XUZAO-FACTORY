import ExcelJS from 'exceljs';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { diffRecords, maskRecord } from '../src/lib/audit-diff.ts';
import { api, createApp, login, resetDb, seedBase, type Fixtures } from './helpers.ts';

let app: FastifyInstance;
let adminCookie: string;
let fx: Fixtures;

beforeAll(async () => {
  await resetDb();
  fx = await seedBase();
  app = await createApp();
  adminCookie = await login(app, 'admin');
});

afterAll(async () => {
  await app.close();
});

describe('审计差异与导出（R23F）', () => {
  it('更新客户后能返回字段级变化', async () => {
    const admin = api(app, adminCookie);
    const created = await admin('POST', '/api/v1/customers', { name: '差异测试客户' });
    expect(created.status).toBe(201);

    const updated = await admin('PATCH', `/api/v1/customers/${created.body.data.id}`, {
      name: '差异测试客户（改名）',
    });
    expect(updated.status).toBe(200);

    const logs = await admin('GET', '/api/v1/audit-logs?action=customer.update&pageSize=10');
    expect(logs.status).toBe(200);
    const entry = logs.body.data.find(
      (row: { resourceId: string }) => row.resourceId === created.body.data.id,
    );
    expect(entry).toBeTruthy();
    expect(entry.changes).toEqual([
      { field: 'name', before: '差异测试客户', after: '差异测试客户（改名）' },
    ]);
  });

  it('敏感字段在差异与返回中都被脱敏', () => {
    const masked = maskRecord({ username: 'admin', passwordHash: 'secret-hash', tokenHash: 'abc' });
    expect(masked).toEqual({ username: 'admin', passwordHash: '***', tokenHash: '***' });

    const changes = diffRecords(
      { passwordHash: 'old-hash' },
      { passwordHash: 'new-hash' },
    );
    expect(changes).toEqual([{ field: 'passwordHash', before: '***', after: '***' }]);
  });

  it('管理员可以导出 xlsx，文件内容与筛选条件一致', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/audit-logs/export.xlsx?action=customer.update',
      headers: { cookie: adminCookie },
    });

    expect(response.statusCode).toBe(200);
    expect(String(response.headers['content-type'])).toContain('spreadsheetml');

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(response.rawPayload as unknown as ArrayBuffer);
    const sheet = workbook.worksheets[0];
    expect(sheet).toBeDefined();
    if (!sheet) throw new Error('导出文件没有工作表');
    expect(sheet.getRow(1).getCell(2).value).toBe('操作');

    const actions = new Set<string>();
    for (let row = 2; row <= sheet.rowCount; row += 1) {
      actions.add(String(sheet.getRow(row).getCell(2).value));
    }
    expect(actions).toEqual(new Set(['customer.update']));
  });

  it('审计记录能反查到所属订单，并出现在导出中', async () => {
    const admin = api(app, adminCookie);
    const logistics = api(app, await login(app, 'logistics'));

    const order = await admin('POST', '/api/v1/orders', {
      customerId: fx.customerId,
      dueDate: '2026-12-31',
      items: [{ productName: '审计订单测试件', spec: 'A-01', quantity: 1, unitPrice: '1.00' }],
    });
    expect(order.status).toBe(201);
    const orderId = order.body.data.id as string;
    const orderNo = order.body.data.orderNo as string;

    const purchase = await admin('POST', `/api/v1/orders/${orderId}/purchase`, {
      supplierId: fx.supplierId,
      partId: fx.partId,
      quantity: 1,
      unitPrice: '0.50',
    });
    const purchaseId = purchase.body.data.flow.purchase.id as string;
    const arrival = await logistics('POST', `/api/v1/purchases/${purchaseId}/arrivals`, {
      quantity: 1,
    });
    expect(arrival.status).toBe(201);

    const logs = await admin('GET', '/api/v1/audit-logs?action=arrival.create&pageSize=20');
    expect(logs.status).toBe(200);
    const entry = logs.body.data.find(
      (row: { orderId: string | null }) => row.orderId === orderId,
    );
    expect(entry).toBeTruthy();
    expect(entry).toMatchObject({ orderId, orderNo, resourceType: 'arrival' });

    const exported = await app.inject({
      method: 'GET',
      url: '/api/v1/audit-logs/export.xlsx?action=arrival.create',
      headers: { cookie: adminCookie },
    });
    expect(exported.statusCode).toBe(200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(exported.rawPayload as unknown as ArrayBuffer);
    const sheet = workbook.worksheets[0];
    expect(sheet).toBeDefined();
    if (!sheet) throw new Error('导出文件没有工作表');
    expect(sheet.getRow(1).getCell(3).value).toBe('订单号');

    const orderNos = new Set<string>();
    for (let row = 2; row <= sheet.rowCount; row += 1) {
      orderNos.add(String(sheet.getRow(row).getCell(3).value));
    }
    expect(orderNos.has(orderNo)).toBe(true);
  });

  it('没有订单上下文的审计记录返回 null', async () => {
    const admin = api(app, adminCookie);
    const logs = await admin('GET', '/api/v1/audit-logs?action=auth.login&pageSize=5');
    expect(logs.status).toBe(200);
    expect(logs.body.data.length).toBeGreaterThan(0);
    expect(logs.body.data[0]).toMatchObject({ orderId: null, orderNo: null });
  });

  it('现场角色不能查看或导出审计', async () => {
    const logistics = api(app, await login(app, 'logistics'));
    expect((await logistics('GET', '/api/v1/audit-logs')).status).toBe(403);

    const exported = await app.inject({
      method: 'GET',
      url: '/api/v1/audit-logs/export.xlsx',
      headers: { cookie: await login(app, 'logistics') },
    });
    expect(exported.statusCode).toBe(403);
  });
});