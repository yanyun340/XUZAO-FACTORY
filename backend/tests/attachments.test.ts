import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config.ts';
import { prisma } from '../src/db.ts';
import { cleanupDeletedAttachments } from '../src/jobs/attachment-cleanup.ts';
import { api, createApp, login, resetDb, seedBase, type Fixtures } from './helpers.ts';

let app: FastifyInstance;
let fx: Fixtures;
let adminCookie: string;
let logisticsCookie: string;

beforeAll(async () => {
  await resetDb();
  fx = await seedBase();
  app = await createApp();
  adminCookie = await login(app, 'admin');
  logisticsCookie = await login(app, 'logistics');
});

afterAll(async () => {
  await app.close();
});

function multipart(fileName: string, mimeType: string, content: string) {
  const boundary = '----xuzao-test-boundary';
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${mimeType}\r\n\r\n`,
    ),
    Buffer.from(content),
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

async function createOrderAndPurchase() {
  const admin = api(app, adminCookie);
  const order = await admin('POST', '/api/v1/orders', {
    customerId: fx.customerId,
    dueDate: '2026-12-31',
    items: [{ productName: '附件测试件', spec: 'F-01', quantity: 10, unitPrice: '1.00' }],
  });
  expect(order.status).toBe(201);

  const purchase = await admin('POST', `/api/v1/orders/${order.body.data.id}/purchase`, {
    supplierId: fx.supplierId,
    partId: fx.partId,
    quantity: 10,
    unitPrice: '0.50',
  });
  expect(purchase.status).toBe(201);

  return {
    orderId: order.body.data.id as string,
    purchaseId: purchase.body.data.flow.purchase.id as string,
  };
}

describe('多层级附件与清理（R17F）', () => {
  it('订单与采购单可以各自挂附件，列表互相隔离', async () => {
    const { orderId, purchaseId } = await createOrderAndPurchase();
    const admin = api(app, adminCookie);

    const orderFile = multipart('order-note.txt', 'text/plain', '订单附件');
    const uploadedOrder = await app.inject({
      method: 'POST',
      url: `/api/v1/orders/${orderId}/attachments`,
      headers: { ...orderFile.headers, cookie: adminCookie },
      payload: orderFile.payload,
    });
    expect(uploadedOrder.statusCode).toBe(201);

    const purchaseFile = multipart('purchase-note.txt', 'text/plain', '采购附件');
    const uploadedPurchase = await app.inject({
      method: 'POST',
      url: `/api/v1/purchase/${purchaseId}/attachments`,
      headers: { ...purchaseFile.headers, cookie: adminCookie },
      payload: purchaseFile.payload,
    });
    expect(uploadedPurchase.statusCode).toBe(201);

    const orderList = await admin('GET', `/api/v1/orders/${orderId}/attachments`);
    expect(orderList.body.data).toHaveLength(1);
    expect(orderList.body.data[0].fileName).toBe('order-note.txt');

    const purchaseList = await admin('GET', `/api/v1/purchase/${purchaseId}/attachments`);
    expect(purchaseList.body.data).toHaveLength(1);
    expect(purchaseList.body.data[0].fileName).toBe('purchase-note.txt');
  });

  it('不存在的业务对象与非法层级会被拒绝', async () => {
    const admin = api(app, adminCookie);
    const missing = await admin(
      'GET',
      '/api/v1/production/00000000-0000-4000-8000-000000000000/attachments',
    );
    expect(missing.status).toBe(404);
    expect(missing.body.error?.code).toBe('OWNER_NOT_FOUND');

    const invalid = await admin(
      'GET',
      '/api/v1/unknown/00000000-0000-4000-8000-000000000000/attachments',
    );
    expect(invalid.status).toBe(400);
  });

  it('软删除后列表与下载都不可见，权限受限', async () => {
    const { orderId } = await createOrderAndPurchase();
    const file = multipart('delete-me.txt', 'text/plain', '待删除');
    const uploaded = await app.inject({
      method: 'POST',
      url: `/api/v1/orders/${orderId}/attachments`,
      headers: { ...file.headers, cookie: adminCookie },
      payload: file.payload,
    });
    expect(uploaded.statusCode).toBe(201);
    const attachmentId = uploaded.json().data.id as string;

    // 其他角色不能删除别人上传的附件
    const forbidden = await api(app, logisticsCookie)(
      'DELETE',
      `/api/v1/attachments/${attachmentId}`,
    );
    expect(forbidden.status).toBe(403);

    const deleted = await api(app, adminCookie)('DELETE', `/api/v1/attachments/${attachmentId}`);
    expect(deleted.status).toBe(200);

    const list = await api(app, adminCookie)('GET', `/api/v1/orders/${orderId}/attachments`);
    expect(list.body.data).toHaveLength(0);

    const download = await api(app, adminCookie)(
      'GET',
      `/api/v1/attachments/${attachmentId}/download`,
    );
    expect(download.status).toBe(404);
  });

  it('超过保留期的软删除附件会被清理（文件与元数据）', async () => {
    const storageKey = 'cleanup-test.txt';
    const uploadRoot = path.resolve(process.cwd(), config.uploadDir);
    await mkdir(uploadRoot, { recursive: true });
    await writeFile(path.join(uploadRoot, storageKey), 'cleanup');

    const adminUser = await prisma.adminUser.findUniqueOrThrow({ where: { username: 'admin' } });
    const row = await prisma.attachment.create({
      data: {
        ownerType: 'order',
        ownerId: fx.customerId,
        fileName: 'old.txt',
        storageKey,
        mimeType: 'text/plain',
        size: 7,
        uploadedById: adminUser.id,
        deletedAt: new Date(Date.now() - 8 * 86_400_000),
      },
    });

    const result = await cleanupDeletedAttachments();
    expect(result.removed).toBeGreaterThanOrEqual(1);
    expect(await prisma.attachment.findUnique({ where: { id: row.id } })).toBeNull();
    await expect(
      (await import('node:fs/promises')).access(path.join(uploadRoot, storageKey)),
    ).rejects.toBeTruthy();
  });
});