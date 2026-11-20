import ExcelJS from 'exceljs';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { diffRecords, maskRecord } from '../src/lib/audit-diff.ts';
import { api, createApp, login, resetDb, seedBase } from './helpers.ts';

let app: FastifyInstance;
let adminCookie: string;

beforeAll(async () => {
  await resetDb();
  await seedBase();
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