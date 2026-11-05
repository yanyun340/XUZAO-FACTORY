/**
 * 审计日志冒烟：列表、筛选、分面、权限，以及"写操作必留痕"。
 * 只连本地开发环境，使用合成数据。
 *
 *   node scripts/smoke-audit.mjs
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

async function call(cookie, method, path, { body, headers = {} } = {}) {
  const finalHeaders = { cookie, ...headers };
  if (body !== undefined) finalHeaders['content-type'] = 'application/json';
  const response = await fetch(`${API}${path}`, {
    method,
    headers: finalHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, payload };
}

async function main() {
  console.log(`序造审计日志冒烟 @ ${BASE}`);
  const admin = await login('admin');
  const production = await login('production');

  // ---------- 权限 ----------
  const denied = await call(production, 'GET', '/audit-logs');
  check('非管理员读取审计日志返回 403', denied.status === 403, `${denied.status}`);
  const facetsDenied = await call(production, 'GET', '/audit-logs/facets');
  check('非管理员读取分面返回 403', facetsDenied.status === 403, `${facetsDenied.status}`);
  const anonymous = await fetch(`${API}/audit-logs`);
  check('未登录读取审计日志返回 401', anonymous.status === 401, `${anonymous.status}`);

  // ---------- 列表 ----------
  const list = await call(admin, 'GET', '/audit-logs?page=1&pageSize=10');
  check('列表返回 200', list.status === 200, JSON.stringify(list.payload).slice(0, 200));
  const rows = list.payload.data ?? [];
  const meta = list.payload.meta ?? {};
  check('列表有数据', Array.isArray(rows) && rows.length > 0);
  check('分页元数据完整', typeof meta.total === 'number' && meta.pageSize === 10 && meta.totalPages >= 1);
  check(
    '单行字段齐全',
    rows.every(
      (row) =>
        typeof row.id === 'string' &&
        typeof row.action === 'string' &&
        typeof row.resourceType === 'string' &&
        (row.result === 'SUCCESS' || row.result === 'FAILED') &&
        typeof row.createdAt === 'string',
    ),
  );
  const sorted = rows.every(
    (row, index) => index === 0 || new Date(rows[index - 1].createdAt) >= new Date(row.createdAt),
  );
  check('按时间倒序', sorted);

  // ---------- 动作筛选 ----------
  const filtered = await call(admin, 'GET', '/audit-logs?action=order.create&pageSize=50');
  const filteredRows = filtered.payload.data ?? [];
  check('动作筛选有结果', filtered.status === 200 && filteredRows.length > 0);
  check('动作筛选只返回该动作', filteredRows.every((row) => row.action === 'order.create'));
  check('筛选后总数与动作一致', filtered.payload.meta.total === filteredRows.length);

  // ---------- 资源类型筛选 ----------
  const byResource = await call(admin, 'GET', '/audit-logs?resourceType=order&pageSize=50');
  check(
    '资源类型筛选只返回该类型',
    byResource.status === 200 &&
      (byResource.payload.data ?? []).length > 0 &&
      (byResource.payload.data ?? []).every((row) => row.resourceType === 'order'),
  );

  // ---------- 关键词 ----------
  const miss = await call(admin, 'GET', '/audit-logs?keyword=__no_such_action_xyz__');
  check('无匹配关键词返回空列表', miss.status === 200 && miss.payload.meta.total === 0);

  // ---------- 时间范围 ----------
  const future = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  const futureList = await call(admin, 'GET', `/audit-logs?from=${encodeURIComponent(future)}`);
  check('未来起点的区间为空', futureList.status === 200 && futureList.payload.meta.total === 0);
  const past = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const pastList = await call(admin, 'GET', `/audit-logs?from=${encodeURIComponent(past)}`);
  check('过去 30 天的区间有数据', pastList.status === 200 && pastList.payload.meta.total > 0);

  // ---------- 分面 ----------
  const facets = await call(admin, 'GET', '/audit-logs/facets');
  check('分面返回 200', facets.status === 200);
  check('分面含动作列表', Array.isArray(facets.payload.data?.actions) && facets.payload.data.actions.length > 0);
  check(
    '分面含资源类型',
    Array.isArray(facets.payload.data?.resourceTypes) && facets.payload.data.resourceTypes.length > 0,
  );
  check('分面含操作人', Array.isArray(facets.payload.data?.actors) && facets.payload.data.actors.length > 0);
  check(
    '分面动作去重',
    new Set(facets.payload.data.actions).size === facets.payload.data.actions.length,
  );

  // 用分面里的操作人再筛一次
  const actor = facets.payload.data.actors[0];
  const byActor = await call(admin, 'GET', `/audit-logs?actorId=${actor.id}&pageSize=20`);
  check(
    '按操作人筛选生效',
    byActor.status === 200 && (byActor.payload.data ?? []).every((row) => row.actorName === actor.displayName),
  );

  // ---------- 写操作必留痕 ----------
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const created = await call(admin, 'POST', '/customers', {
    body: { name: `审计冒烟客户 ${suffix}`, contact: '测试联系人' },
  });
  check('创建客户成功', created.status === 201, JSON.stringify(created.payload).slice(0, 200));
  const customerId = created.payload.data?.id;

  const trace = await call(admin, 'GET', `/audit-logs?resourceId=${customerId}&pageSize=10`);
  const traceRows = trace.payload.data ?? [];
  check('新写操作产生审计记录', trace.status === 200 && traceRows.length === 1);
  check('审计动作正确', traceRows[0]?.action === 'customer.create');
  check('审计记录操作人正确', traceRows[0]?.actorName === '管理员', traceRows[0]?.actorName);
  check('审计记录带请求 ID', typeof traceRows[0]?.requestId === 'string' && traceRows[0].requestId.length > 0);
  check(
    '审计记录保留改后内容',
    traceRows[0]?.after && JSON.stringify(traceRows[0].after).includes('审计冒烟客户'),
  );

  console.log('');
  if (failures === 0) {
    console.log('审计日志冒烟：全部通过');
  } else {
    console.error(`审计日志冒烟：${failures} 项失败`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('[smoke-audit] 失败：', error);
  process.exitCode = 1;
});