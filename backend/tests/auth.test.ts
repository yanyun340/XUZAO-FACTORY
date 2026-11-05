import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/db.ts';
import { api, createApp, login, resetDb, seedBase, TEST_PASSWORD, type Fixtures } from './helpers.ts';

let app: FastifyInstance;
let fx: Fixtures;
let admin: ReturnType<typeof api>;

beforeAll(async () => {
  await resetDb();
  fx = await seedBase();
  app = await createApp();
  admin = api(app, await login(app, 'admin'));
});

afterAll(async () => {
  await app.close();
});

async function rawLogin(username: string, password = TEST_PASSWORD) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username, password },
  });
  return {
    status: response.statusCode,
    headers: response.headers,
    json: () => response.json(),
  };
}

let counter = 0;
async function createUser(
  role: string,
  overrides: { username?: string; departmentId?: string | null } = {},
): Promise<{ id: string; username: string }> {
  counter += 1;
  const username = overrides.username ?? `auth-user-${counter}`;
  const response = await admin('POST', '/api/v1/users', {
    username,
    password: TEST_PASSWORD,
    displayName: `测试账号${counter}`,
    role,
    departmentId: overrides.departmentId ?? null,
  });
  expect(response.status).toBe(201);
  return response.body.data;
}

describe('登录与会话', () => {
  it('未登录访问受保护接口返回 401', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/auth/me' });
    expect(response.statusCode).toBe(401);
  });

  it('密码错误统一返回 401，且不下发会话', async () => {
    const response = await rawLogin('admin', 'wrong-password');
    expect(response.status).toBe(401);
    expect(response.json().error.code).toBe('AUTH_INVALID_CREDENTIALS');
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('登录成功返回用户信息并下发 HttpOnly Cookie', async () => {
    const response = await rawLogin('admin');
    expect(response.status).toBe(200);
    expect(response.json().data.user.role).toBe('ADMIN');

    const cookie = String(response.headers['set-cookie']);
    expect(cookie).toContain('xuzao_session=');
    expect(cookie.toLowerCase()).toContain('httponly');
  });

  it('登出后旧会话立即失效', async () => {
    const cookie = await login(app, 'logistics');
    expect((await api(app, cookie)('GET', '/api/v1/auth/me')).status).toBe(200);

    const logout = await api(app, cookie)('POST', '/api/v1/auth/logout');
    expect(logout.status).toBe(200);

    const after = await api(app, cookie)('GET', '/api/v1/auth/me');
    expect(after.status).toBe(401);
    expect(after.body.error?.code).toBe('SESSION_EXPIRED');
  });
});

describe('角色边界', () => {
  it('只有管理员能读取账号列表', async () => {
    expect((await admin('GET', '/api/v1/users')).status).toBe(200);
    for (const username of ['logistics', 'production', 'qc', 'packing']) {
      const caller = api(app, await login(app, username));
      const response = await caller('GET', '/api/v1/users');
      expect(response.status, `${username} 不应能读取账号列表`).toBe(403);
    }
  });
});

describe('账号管理', () => {
  it('创建账号并可用新密码登录', async () => {
    const user = await createUser('QC', { departmentId: fx.departments.QC });
    const response = await rawLogin(user.username);
    expect(response.status).toBe(200);
    expect(response.json().data.user.role).toBe('QC');
    expect(response.json().data.user.department.id).toBe(fx.departments.QC);
  });

  it('用户名重复返回 409', async () => {
    const user = await createUser('PACKING');
    const response = await admin('POST', '/api/v1/users', {
      username: user.username,
      password: TEST_PASSWORD,
      displayName: '重复账号',
      role: 'PACKING',
    });
    expect(response.status).toBe(409);
    expect(response.body.error?.code).toBe('DUPLICATE_VALUE');
  });

  it('改角色会吊销旧会话，重新登录拿到新角色', async () => {
    const user = await createUser('LOGISTICS');
    const cookie = await login(app, user.username);
    const caller = api(app, cookie);

    expect((await caller('GET', '/api/v1/auth/me')).body.data.user.role).toBe('LOGISTICS');
    expect((await caller('GET', '/api/v1/orders')).status).toBe(200);

    const updated = await admin('PATCH', `/api/v1/users/${user.id}`, { role: 'PACKING' });
    expect(updated.status).toBe(200);
    expect(updated.body.data.sessionsRevoked).toBe(true);
    expect((await caller('GET', '/api/v1/auth/me')).status).toBe(401);

    const relogin = await rawLogin(user.username);
    expect(relogin.status).toBe(200);
    expect(relogin.json().data.user.role).toBe('PACKING');
  });

  it('重置密码会让旧密码和旧会话同时失效', async () => {
    const user = await createUser('PRODUCTION', { departmentId: fx.departments.PROD });
    const cookie = await login(app, user.username);

    const reset = await admin('POST', `/api/v1/users/${user.id}/password`, {
      password: 'New-pass-2026',
    });
    expect(reset.status).toBe(200);
    expect(reset.body.data.sessionsRevoked).toBe(true);

    expect((await api(app, cookie)('GET', '/api/v1/auth/me')).status).toBe(401);
    expect((await rawLogin(user.username, TEST_PASSWORD)).status).toBe(401);

    const relogin = await rawLogin(user.username, 'New-pass-2026');
    expect(relogin.status).toBe(200);
  });

  it('停用后不能登录，已签发会话失效', async () => {
    const user = await createUser('QC', { departmentId: fx.departments.QC });
    const cookie = await login(app, user.username);

    const disabled = await admin('PATCH', `/api/v1/users/${user.id}`, { active: false });
    expect(disabled.status).toBe(200);
    expect(disabled.body.data.active).toBe(false);
    expect(disabled.body.data.sessionsRevoked).toBe(true);

    expect((await api(app, cookie)('GET', '/api/v1/auth/me')).status).toBe(401);
    expect((await rawLogin(user.username)).status).toBe(401);
  });

  it('主动吊销会话会返回吊销数量', async () => {
    const user = await createUser('LOGISTICS');
    const cookie = await login(app, user.username);

    const revoked = await admin('POST', `/api/v1/users/${user.id}/revoke-sessions`);
    expect(revoked.status).toBe(200);
    expect(revoked.body.data.revoked).toBeGreaterThanOrEqual(1);
    expect((await api(app, cookie)('GET', '/api/v1/auth/me')).status).toBe(401);
  });

  it('管理员不能停用或降级自己', async () => {
    const me = await admin('GET', '/api/v1/auth/me');
    const selfId = me.body.data.user.id;

    const disable = await admin('PATCH', `/api/v1/users/${selfId}`, { active: false });
    expect(disable.status).toBe(400);
    expect(disable.body.error?.code).toBe('CANNOT_DISABLE_SELF');

    const demote = await admin('PATCH', `/api/v1/users/${selfId}`, { role: 'PACKING' });
    expect(demote.status).toBe(400);
    expect(demote.body.error?.code).toBe('CANNOT_CHANGE_OWN_ROLE');
  });

  it('账号变更都写入审计日志', async () => {
    const actions = await prisma.auditLog.findMany({
      where: { resourceType: 'user' },
      select: { action: true },
      distinct: ['action'],
    });
    const found = actions.map((row) => row.action).sort();
    expect(found).toEqual(
      expect.arrayContaining([
        'user.create',
        'user.update',
        'user.password.reset',
        'user.sessions.revoke',
      ]),
    );
  });
});