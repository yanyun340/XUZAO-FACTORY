/**
 * 账号管理与会话吊销冒烟：停用、改角色、重置密码、主动吊销、交期提醒去重。
 * 只连本地开发环境，使用合成数据。
 *
 *   node scripts/smoke-admin.mjs
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

async function login(username, password = PASSWORD) {
  const response = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const raw = response.headers.getSetCookie?.() ?? [];
  const cookie = raw.map((value) => value.split(';')[0]).join('; ');
  if (!response.ok || !cookie) {
    throw new Error(`登录失败 ${username}: ${response.status} ${await response.text()}`);
  }
  return cookie;
}

async function tryLogin(username, password) {
  const response = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  return response.status;
}

async function call(cookie, method, path, { body } = {}) {
  const headers = { cookie };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, payload };
}

async function main() {
  console.log(`序造账号管理冒烟 @ ${BASE}`);
  const admin = await login('admin');
  const production = await login('production');

  // ---------- 权限 ----------
  check('非管理员读取用户列表 403', (await call(production, 'GET', '/users')).status === 403);
  check(
    '非管理员创建用户 403',
    (await call(production, 'POST', '/users', {
      body: { username: 'nope', password: 'Passw0rd!', displayName: 'x', role: 'QC' },
    })).status === 403,
  );

  // ---------- 列表 ----------
  const list = await call(admin, 'GET', '/users?page=1&pageSize=50');
  check('用户列表 200', list.status === 200, JSON.stringify(list.payload).slice(0, 200));
  const users = list.payload.data ?? [];
  check('列表含种子账号', users.some((user) => user.username === 'admin'));
  check('列表不返回密码哈希', users.every((user) => !('passwordHash' in user)));
  check('列表带活跃会话数', users.every((user) => typeof user.activeSessions === 'number'));

  // ---------- 创建 ----------
  const username = `smoke_${Date.now().toString(36)}`;
  const created = await call(admin, 'POST', '/users', {
    body: {
      username,
      password: 'Smoke-pass-2026',
      displayName: '冒烟品控',
      role: 'QC',
    },
  });
  check('创建用户 201', created.status === 201, JSON.stringify(created.payload).slice(0, 200));
  const userId = created.payload.data?.id;
  check('新用户默认启用', created.payload.data?.active === true);

  const duplicate = await call(admin, 'POST', '/users', {
    body: { username, password: 'Smoke-pass-2026', displayName: '重复', role: 'QC' },
  });
  check('重复用户名 409', duplicate.status === 409, `${duplicate.status}`);

  // ---------- 新用户登录 ----------
  let userCookie = await login(username, 'Smoke-pass-2026');
  const me = await call(userCookie, 'GET', '/auth/me');
  check('新用户可登录', me.status === 200 && me.payload.data.user.username === username);
  check('新用户角色为 QC', me.payload.data.user.role === 'QC');

  // ---------- 改角色吊销会话 ----------
  const promoted = await call(admin, 'PATCH', `/users/${userId}`, { body: { role: 'PACKING' } });
  check('修改角色 200', promoted.status === 200, JSON.stringify(promoted.payload).slice(0, 200));
  check('修改角色后旧会话失效', (await call(userCookie, 'GET', '/auth/me')).status === 401);
  userCookie = await login(username, 'Smoke-pass-2026');
  const afterPromote = await call(userCookie, 'GET', '/auth/me');
  check('重新登录后角色已更新', afterPromote.payload.data.user.role === 'PACKING');

  // ---------- 主动吊销 ----------
  const revoked = await call(admin, 'POST', `/users/${userId}/revoke-sessions`);
  check('吊销会话 200', revoked.status === 200);
  check('吊销返回数量', typeof revoked.payload.data?.revoked === 'number' && revoked.payload.data.revoked > 0);
  check('吊销后会话失效', (await call(userCookie, 'GET', '/auth/me')).status === 401);

  // ---------- 重置密码 ----------
  userCookie = await login(username, 'Smoke-pass-2026');
  const reset = await call(admin, 'POST', `/users/${userId}/password`, {
    body: { password: 'Smoke-reset-2026' },
  });
  check('重置密码 200', reset.status === 200);
  check('重置后旧会话失效', (await call(userCookie, 'GET', '/auth/me')).status === 401);
  check('旧密码不能登录', (await tryLogin(username, 'Smoke-pass-2026')) === 401);
  userCookie = await login(username, 'Smoke-reset-2026');

  // ---------- 停用 ----------
  const disabled = await call(admin, 'PATCH', `/users/${userId}`, { body: { active: false } });
  check('停用账号 200', disabled.status === 200);
  check('停用后会话失效', (await call(userCookie, 'GET', '/auth/me')).status === 401);
  check('停用后不能登录', (await tryLogin(username, 'Smoke-reset-2026')) === 401);

  const selfDisable = await call(admin, 'PATCH', '/users/' + users.find((u) => u.username === 'admin').id, {
    body: { active: false },
  });
  check('不能停用自己 400', selfDisable.status === 400, `${selfDisable.status}`);

  // ---------- 交期提醒 ----------
  const reminder = await call(admin, 'POST', '/jobs/due-reminders');
  check('手动触发交期提醒 200', reminder.status === 200, JSON.stringify(reminder.payload).slice(0, 200));
  const first = reminder.payload.data ?? {};
  check('返回业务日期', /^\d{4}-\d{2}-\d{2}$/.test(first.businessDate ?? ''));
  const again = await call(admin, 'POST', '/jobs/due-reminders');
  check('同日重复触发不重复发送', again.payload.data?.created === 0, JSON.stringify(again.payload.data));
  check('非管理员不能触发提醒', (await call(production, 'POST', '/jobs/due-reminders')).status === 403);

  // ---------- 审计留痕 ----------
  const trace = await call(admin, 'GET', `/audit-logs?resourceId=${userId}&pageSize=20`);
  const actions = (trace.payload.data ?? []).map((row) => row.action);
  check('创建用户写审计', actions.includes('user.create'));
  check('修改用户写审计', actions.includes('user.update'));
  check('重置密码写审计', actions.includes('user.password.reset'));
  check('吊销会话写审计', actions.includes('user.sessions.revoke'));

  console.log('');
  if (failures === 0) {
    console.log('账号管理冒烟：全部通过');
  } else {
    console.error(`账号管理冒烟：${failures} 项失败`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('[smoke-admin] 失败：', error);
  process.exitCode = 1;
});