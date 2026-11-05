/**
 * 配套能力冒烟：通知 / 看板 / 库存 / 异常 / Excel 导出 / 附件。
 * 只连本地开发环境，使用合成数据。
 *
 *   node scripts/smoke-collab.mjs
 */
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3001';
const API = `${BASE}/api/v1`;
const PASSWORD = process.env.SEED_DEMO_PASSWORD ?? 'XuZao-demo-2026';

let failures = 0;

function check(label, condition, detail) {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${label}`, detail ?? '');
  }
}

async function login(username) {
  const response = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: PASSWORD }),
  });
  const raw = response.headers.getSetCookie?.() ?? [];
  const cookie = raw.map((value) => value.split(';')[0]).join('; ');
  if (!response.ok || !cookie) {
    throw new Error(`登录失败 ${username}: ${response.status} ${await response.text()}`);
  }
  return cookie;
}

async function call(cookie, method, path, { body, key, headers = {} } = {}) {
  const finalHeaders = { cookie, ...headers };
  if (body !== undefined) finalHeaders['content-type'] = 'application/json';
  if (key) finalHeaders['idempotency-key'] = key;
  const response = await fetch(`${API}${path}`, {
    method,
    headers: finalHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, payload, headers: response.headers };
}

function expectOk(label, result, expected = 200) {
  check(
    label,
    result.status === expected,
    result.status !== expected ? `${result.status} ${JSON.stringify(result.payload)}` : '',
  );
  return result.payload.data;
}

function nowKey(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function main() {
  console.log(`序造配套能力冒烟 @ ${BASE}`);
  const admin = await login('admin');
  const production = await login('production');

  // ---------- 看板 ----------
  const dashboard = expectOk('看板返回状态统计与利润', await call(admin, 'GET', '/dashboard'));
  check(
    '看板字段齐全',
    typeof dashboard.totalOrders === 'number' &&
      typeof dashboard.profit.sales === 'string' &&
      Array.isArray(dashboard.recentOrders),
    JSON.stringify(dashboard).slice(0, 200),
  );

  // ---------- 通知 ----------
  const summary = expectOk('通知汇总', await call(admin, 'GET', '/notifications/summary'));
  check('未读数量是非负整数', Number.isInteger(summary.unread) && summary.unread >= 0);

  const list = await call(admin, 'GET', '/notifications?page=1&pageSize=10');
  expectOk('通知列表', list);

  if (list.payload.data.length > 0) {
    const first = list.payload.data[0];
    const read = expectOk('标记单条已读', await call(admin, 'POST', `/notifications/${first.id}/read`));
    check('已读时间已写入', Boolean(read.readAt));
    const again = expectOk(
      '重复标记已读幂等',
      await call(admin, 'POST', `/notifications/${first.id}/read`),
    );
    check('重复标记返回同一时间', again.readAt === read.readAt);
  } else {
    console.log('  · 当前没有通知，跳过已读测试');
  }

  expectOk('全部标记已读', await call(admin, 'POST', '/notifications/read-all'));

  const missingRead = await call(admin, 'POST', '/notifications/00000000-0000-0000-0000-000000000000/read');
  check(
    '不存在的通知返回 404',
    missingRead.status === 404 && missingRead.payload?.error?.code === 'NOTIFICATION_NOT_FOUND',
    `${missingRead.status} ${JSON.stringify(missingRead.payload)}`,
  );

  // ---------- 库存 ----------
  const partsPage = await call(admin, 'GET', '/inventory/parts?pageSize=10');
  const parts = expectOk('配件库存列表', partsPage);
  check('配件库存带数量字段', parts.length === 0 || typeof parts[0].quantity === 'number');

  if (parts.length > 0) {
    const part = parts[0];
    const before = part.quantity;

    const plus = expectOk(
      '配件入库 +7',
      await call(admin, 'POST', `/inventory/parts/${part.id}/adjust`, {
        body: { delta: 7, reason: '冒烟测试入库' },
      }),
    );
    check('入库后数量正确', plus.after === before + 7 && plus.before === before, JSON.stringify(plus));

    const minus = expectOk(
      '配件出库 -7',
      await call(admin, 'POST', `/inventory/parts/${part.id}/adjust`, {
        body: { delta: -7, reason: '冒烟测试出库' },
      }),
    );
    check('出库后数量回到原值', minus.after === before, JSON.stringify(minus));

    const negative = await call(admin, 'POST', `/inventory/parts/${part.id}/adjust`, {
      body: { delta: -1_000_000, reason: '冒烟测试负库存' },
    });
    check(
      '不允许扣成负数',
      negative.status === 409 && negative.payload?.error?.code === 'INSUFFICIENT_STOCK',
      `${negative.status} ${JSON.stringify(negative.payload)}`,
    );

    const zeroDelta = await call(admin, 'POST', `/inventory/parts/${part.id}/adjust`, {
      body: { delta: 0, reason: '零调整' },
    });
    check('拒绝 0 调整', zeroDelta.status === 400, String(zeroDelta.status));

    const forbidden = await call(production, 'POST', `/inventory/parts/${part.id}/adjust`, {
      body: { delta: 1, reason: '越权测试' },
    });
    check('非管理员不能调整库存', forbidden.status === 403, String(forbidden.status));

    // 并发扣减：10 个请求同时 -1，成功数不能超过库存
    const start = Date.now();
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        call(admin, 'POST', `/inventory/parts/${part.id}/adjust`, {
          body: { delta: -1, reason: '并发冒烟' },
        }),
      ),
    );
    const successCount = results.filter((item) => item.status === 200).length;
    const finalRow = (await call(admin, 'GET', '/inventory/parts?pageSize=100')).payload.data.find(
      (row) => row.id === part.id,
    );
    check(
      '并发扣减不出现负库存',
      finalRow.quantity >= 0,
      JSON.stringify({ successCount, quantity: finalRow.quantity, ms: Date.now() - start }),
    );

    // 回补并发扣掉的数量，保持演示数据稳定
    if (successCount > 0) {
      await call(admin, 'POST', `/inventory/parts/${part.id}/adjust`, {
        body: { delta: successCount, reason: '冒烟测试回补' },
      });
    }
  } else {
    console.log('  · 没有配件，跳过库存调整测试');
  }

  const logs = await call(admin, 'GET', '/inventory/logs?page=1&pageSize=5');
  const logRows = expectOk('库存流水列表', logs);
  check('流水带调整原因', logRows.length === 0 || typeof logRows[0].reason === 'string');

  // 商品唯一性
  const productName = `冒烟产品-${Date.now()}`;
  const created = expectOk(
    '新建商品库存',
    await call(admin, 'POST', '/inventory/products', {
      body: { productName, spec: '测试规格', quantity: 3, reason: '冒烟建档' },
    }),
    201,
  );
  const duplicate = await call(admin, 'POST', '/inventory/products', {
    body: { productName, spec: '测试规格', quantity: 0 },
  });
  check(
    '同名同规格产品不能重复建档',
    duplicate.status === 409 && duplicate.payload?.error?.code === 'PRODUCT_ALREADY_EXISTS',
    `${duplicate.status} ${JSON.stringify(duplicate.payload)}`,
  );
  check('新建商品初始数量正确', created.quantity === 3, JSON.stringify(created));

  // ---------- 异常 ----------
  const orders = (await call(admin, 'GET', '/orders?pageSize=1')).payload.data;
  if (orders.length > 0) {
    const orderId = orders[0].id;
    const reported = expectOk(
      '非管理员可上报异常',
      await call(production, 'POST', '/exceptions', {
        body: { orderId, description: '冒烟测试：配件表面有划痕，申请复核' },
      }),
      201,
    );
    check('异常初始状态是 OPEN', reported.status === 'OPEN', JSON.stringify(reported));

    const listExceptions = await call(admin, 'GET', '/exceptions?page=1&pageSize=5');
    const exceptions = expectOk('管理员可查看异常列表', listExceptions);
    check('异常列表带上报人', exceptions.every((row) => typeof row.reporterName === 'string'));

    const nonAdminList = await call(production, 'GET', '/exceptions');
    check('非管理员不能查看异常列表', nonAdminList.status === 403, String(nonAdminList.status));
  }

  // ---------- Excel 导出 ----------
  const exportResponse = await fetch(`${API}/orders/export.xlsx`, { headers: { cookie: admin } });
  check('管理员可导出 xlsx', exportResponse.status === 200, String(exportResponse.status));
  check(
    '导出内容是 xlsx 类型',
    exportResponse.headers.get('content-type')?.includes('spreadsheetml'),
    exportResponse.headers.get('content-type') ?? '',
  );
  const bytes = Buffer.from(await exportResponse.arrayBuffer());
  check('xlsx 是 ZIP 容器（PK 头）', bytes[0] === 0x50 && bytes[1] === 0x4b, `${bytes[0]} ${bytes[1]}`);
  check('xlsx 大小合理', bytes.length > 2000, String(bytes.length));

  const forbiddenExport = await fetch(`${API}/orders/export.xlsx`, { headers: { cookie: production } });
  check('非管理员不能导出', forbiddenExport.status === 403, String(forbiddenExport.status));

  // ---------- 附件 ----------
  if (orders.length > 0) {
    const orderId = orders[0].id;
    const form = new FormData();
    form.append(
      'file',
      new Blob([Buffer.from('%PDF-1.4\n% smoke test\n')], { type: 'application/pdf' }),
      '冒烟附件.pdf',
    );

    const uploadResponse = await fetch(`${API}/orders/${orderId}/attachments`, {
      method: 'POST',
      headers: { cookie: admin, origin: 'http://localhost:5173' },
      body: form,
    });
    const uploadPayload = await uploadResponse.json().catch(() => ({}));
    check('上传 PDF 附件', uploadResponse.status === 201, `${uploadResponse.status} ${JSON.stringify(uploadPayload)}`);

    const attachmentId = uploadPayload?.data?.id;
    if (attachmentId) {
      const download = await fetch(`${API}/attachments/${attachmentId}/download`, {
        headers: { cookie: admin },
      });
      const downloaded = Buffer.from(await download.arrayBuffer());
      check('下载附件成功', download.status === 200, String(download.status));
      check('下载内容与上传一致', downloaded.toString().startsWith('%PDF-1.4'), String(downloaded.length));
      check(
        '下载头包含文件名',
        /filename\*=UTF-8''/.test(download.headers.get('content-disposition') ?? ''),
        download.headers.get('content-disposition') ?? '',
      );
    }

    const badType = new FormData();
    badType.append('file', new Blob(['<script>'], { type: 'text/html' }), 'evil.html');
    const badResponse = await fetch(`${API}/orders/${orderId}/attachments`, {
      method: 'POST',
      headers: { cookie: admin, origin: 'http://localhost:5173' },
      body: badType,
    });
    const badPayload = await badResponse.json().catch(() => ({}));
    check(
      '拒绝不在白名单的文件类型',
      badResponse.status === 400 && badPayload?.error?.code === 'ATTACHMENT_TYPE_NOT_ALLOWED',
      `${badResponse.status} ${JSON.stringify(badPayload)}`,
    );

    const listAttachments = await call(admin, 'GET', `/orders/${orderId}/attachments`);
    const attachments = expectOk('订单附件列表', listAttachments);
    check('附件列表包含刚上传的文件', attachments.some((row) => row.id === attachmentId));
  }

  console.log('');
  if (failures > 0) {
    console.error(`失败 ${failures} 项`);
    process.exitCode = 1;
  } else {
    console.log('全部通过');
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});