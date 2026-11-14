import ExcelJS from 'exceljs';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/db.ts';
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

async function workbook(headers: string[], rows: string[][]): Promise<Buffer> {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('DATA');
  sheet.addRow(headers);
  for (const row of rows) sheet.addRow(row);
  return Buffer.from(await book.xlsx.writeBuffer());
}

function multipartXlsx(content: Buffer) {
  const boundary = '----xuzao-import-boundary';
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="import.xlsx"\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n`,
    ),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return {
    payload,
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      origin: 'http://localhost:5173',
    },
  };
}

async function preflight(entity: string, content: Buffer, cookie = adminCookie) {
  const body = multipartXlsx(content);
  return app.inject({
    method: 'POST',
    url: `/api/v1/imports/${entity}/preflight`,
    headers: { ...body.headers, cookie },
    payload: body.payload,
  });
}

describe('Excel 导入（R18F）', () => {
  it('模板可下载且包含标准表头', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/imports/customer/template.xlsx',
      headers: { cookie: adminCookie },
    });
    expect(response.statusCode).toBe(200);
    expect(String(response.headers['content-type'])).toContain('spreadsheetml');

    const book = new ExcelJS.Workbook();
    await book.xlsx.load(response.rawPayload as unknown as ArrayBuffer);
    const sheet = book.worksheets[0];
    expect(sheet).toBeDefined();
    if (!sheet) throw new Error('模板没有工作表');
    expect(sheet.getRow(1).getCell(1).text).toBe('名称');
  });

  it('预检通过后整批原子提交，重复提交被拒绝', async () => {
    const content = await workbook(
      ['名称', '联系人', '电话', '编码'],
      [
        ['导入客户甲', '王工', '13800000001', 'CUS-IMP-01'],
        ['导入客户乙', '', '', ''],
      ],
    );

    const pre = await preflight('customer', content);
    expect(pre.statusCode).toBe(201);
    const result = pre.json();
    expect(result.data).toMatchObject({ rowCount: 2, errorCount: 0 });
    const batchId = result.data.batchId as string;

    // 预检不写业务表
    expect(await prisma.customer.count({ where: { name: { startsWith: '导入客户' } } })).toBe(0);

    const committed = await api(app, adminCookie)('POST', '/api/v1/imports/customer/commit', {
      batchId,
    });
    expect(committed.status).toBe(200);
    expect(committed.body.data.committed).toBe(2);
    expect(await prisma.customer.count({ where: { name: { startsWith: '导入客户' } } })).toBe(2);

    const retry = await api(app, adminCookie)('POST', '/api/v1/imports/customer/commit', {
      batchId,
    });
    expect(retry.status).toBe(409);
    expect(retry.body.error?.code).toBe('IMPORT_ALREADY_COMMITTED');
    expect(await prisma.customer.count({ where: { name: { startsWith: '导入客户' } } })).toBe(2);
  });

  it('有错误行时拒绝提交，返回行号与原因', async () => {
    const content = await workbook(
      ['名称', '规格', '编码'],
      [
        ['合法配件', 'P-01', 'PRT-IMP-01'],
        ['', 'P-02', 'PRT-IMP-02'],
        ['重复编码配件', 'P-03', 'PRT-IMP-01'],
      ],
    );

    const pre = await preflight('part', content);
    expect(pre.statusCode).toBe(201);
    const result = pre.json();
    expect(result.data.errorCount).toBe(2);
    expect(result.data.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rowNo: 3, field: '名称' }),
        expect.objectContaining({ rowNo: 4, field: '编码' }),
      ]),
    );

    const committed = await api(app, adminCookie)('POST', '/api/v1/imports/part/commit', {
      batchId: result.data.batchId,
    });
    expect(committed.status).toBe(422);
    expect(committed.body.error?.code).toBe('IMPORT_HAS_ERRORS');
    expect(await prisma.part.count({ where: { code: { startsWith: 'PRT-IMP' } } })).toBe(0);
  });

  it('员工导入校验部门编码，非法部门整批不写', async () => {
    const content = await workbook(
      ['姓名', '部门编码', '编码'],
      [
        ['导入员工甲', 'PROD', 'EMP-IMP-01'],
        ['导入员工乙', 'NO-SUCH', 'EMP-IMP-02'],
      ],
    );

    const pre = await preflight('employee', content);
    expect(pre.statusCode).toBe(201);
    const result = pre.json();
    expect(result.data.errorCount).toBe(1);
    expect(result.data.errors[0]).toMatchObject({ rowNo: 3, field: '部门编码' });

    expect(await prisma.employee.count({ where: { code: { startsWith: 'EMP-IMP' } } })).toBe(0);
  });

  it('表头不匹配与非法文件类型被拒绝，现场角色无权导入', async () => {
    const badHeader = await workbook(['名字', '电话'], [['张三', '123']]);
    const mismatch = await preflight('customer', badHeader);
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.json().error.code).toBe('IMPORT_HEADER_MISMATCH');

    const logisticsCookie = await login(app, 'logistics');
    const valid = await workbook(['名称'], [['无权客户']]);
    const forbidden = await preflight('customer', valid, logisticsCookie);
    expect(forbidden.statusCode).toBe(403);
  });
});