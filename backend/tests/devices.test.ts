import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/db.ts';
import {
  api,
  createApp,
  login,
  resetDb,
  seedBase,
  TEST_PASSWORD,
  type Fixtures,
} from './helpers.ts';

let app: FastifyInstance;
let fx: Fixtures;
let admin: ReturnType<typeof api>;
let admin2Cookie: string;
let packingId: string;

const DEVICE_A = 'device-key-aaaaaaaaaaaaaaaa';
const DEVICE_B = 'device-key-bbbbbbbbbbbbbbbb';

beforeAll(async () => {
  await resetDb();
  fx = await seedBase();
  app = await createApp();
  admin = api(app, await login(app, 'admin'));
  packingId = fx.users.packing;

  const created = await admin('POST', '/api/v1/users', {
    username: 'device-admin',
    password: TEST_PASSWORD,
    displayName: '设备管理员',
    role: 'ADMIN',
    departmentId: null,
  });
  expect(created.status).toBe(201);
  admin2Cookie = await login(app, 'device-admin');
});

afterAll(async () => {
  await app.close();
});

function loginPacking(deviceKey?: string) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username: 'packing', password: TEST_PASSWORD },
    headers: deviceKey ? { 'x-device-id': deviceKey } : {},
  });
}

function cookieOf(headers: Record<string, unknown>): string | null {
  const raw = headers['set-cookie'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  return String(value).split(';')[0] ?? null;
}

describe('受控设备（R01F）', () => {
  it('未开启受控设备时，任意设备都能登录', async () => {
    const response = await loginPacking(DEVICE_A);
    expect(response.statusCode).toBe(200);
    expect(cookieOf(response.headers)).toBeTruthy();

    const session = await prisma.session.findFirstOrThrow({
      where: { userId: packingId },
      orderBy: { createdAt: 'desc' },
    });
    expect(session.deviceId).toBeNull();
  });

  it('管理员不能对自己开启受控设备', async () => {
    const own = await prisma.adminUser.findUniqueOrThrow({ where: { username: 'device-admin' } });
    const response = await api(app, admin2Cookie)('PATCH', `/api/v1/users/${own.id}`, {
      deviceBindingMode: 'ENFORCED',
    });
    expect(response.status).toBe(400);
    expect(response.body.error?.code).toBe('CANNOT_ENFORCE_SELF');
  });

  it('开启后新设备登录返回 403，并生成待批准记录', async () => {
    const enabled = await api(app, admin2Cookie)('PATCH', `/api/v1/users/${packingId}`, {
      deviceBindingMode: 'ENFORCED',
    });
    expect(enabled.status).toBe(200);
    expect(enabled.body.data.deviceBindingMode).toBe('ENFORCED');
    expect(enabled.body.data.sessionsRevoked).toBe(true);

    const denied = await loginPacking(DEVICE_A);
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe('DEVICE_NOT_ALLOWED');
    expect(denied.json().error.details.deviceCode).toMatch(/^[A-F0-9]{8}$/);
    expect(cookieOf(denied.headers)).toBeNull();

    const device = await prisma.device.findUnique({
      where: { userId_deviceKey: { userId: packingId, deviceKey: DEVICE_A } },
    });
    expect(device?.status).toBe('PENDING');
  });

  it('缺少设备头也拒绝，并提示 NO-DEVICE', async () => {
    const denied = await loginPacking();
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.details.deviceCode).toBe('NO-DEVICE');
  });

  it('管理员批准后同设备可以登录，会话记录设备', async () => {
    const list = await api(app, admin2Cookie)('GET', `/api/v1/users/${packingId}/devices`);
    expect(list.status).toBe(200);
    const pending = list.body.data.find((row: { status: string }) => row.status === 'PENDING');
    expect(pending).toBeTruthy();

    const approved = await api(app, admin2Cookie)(
      'PATCH',
      `/api/v1/users/${packingId}/devices/${pending.id}`,
      { status: 'ACTIVE' },
    );
    expect(approved.status).toBe(200);

    const allowed = await loginPacking(DEVICE_A);
    expect(allowed.statusCode).toBe(200);
    const cookie = cookieOf(allowed.headers)!;
    expect(cookie).toBeTruthy();

    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);

    const session = await prisma.session.findFirstOrThrow({
      where: { userId: packingId, revokedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    expect(session.deviceId).toBeTruthy();
  });

  it('另一台设备仍然是待批准，不会因为同账号已有一台被放行', async () => {
    const denied = await loginPacking(DEVICE_B);
    expect(denied.statusCode).toBe(403);

    const rows = await prisma.device.findMany({ where: { userId: packingId } });
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.status === 'ACTIVE')).toHaveLength(1);
    expect(rows.filter((row) => row.status === 'PENDING')).toHaveLength(1);
  });

  it('吊销设备后该设备的会话立即失效，且不能自动复活', async () => {
    const device = await prisma.device.findFirstOrThrow({
      where: { userId: packingId, deviceKey: DEVICE_A },
    });
    const revoked = await api(app, admin2Cookie)(
      'PATCH',
      `/api/v1/users/${packingId}/devices/${device.id}`,
      { status: 'REVOKED' },
    );
    expect(revoked.status).toBe(200);

    const activeSessions = await prisma.session.count({
      where: { userId: packingId, revokedAt: null },
    });
    expect(activeSessions).toBe(0);

    const denied = await loginPacking(DEVICE_A);
    expect(denied.statusCode).toBe(403);
  });

  it('删除最后一台设备会自动关闭受控，账号恢复任意设备登录', async () => {
    const devices = await prisma.device.findMany({ where: { userId: packingId } });
    for (const device of devices) {
      const removed = await api(app, admin2Cookie)(
        'DELETE',
        `/api/v1/users/${packingId}/devices/${device.id}`,
      );
      expect(removed.status).toBe(200);
    }

    const user = await prisma.adminUser.findUniqueOrThrow({ where: { id: packingId } });
    expect(user.deviceBindingMode).toBe('OFF');

    const allowed = await loginPacking(DEVICE_B);
    expect(allowed.statusCode).toBe(200);
  });

  it('设备标识格式非法会被拒绝', async () => {
    const response = await loginPacking('short');
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('DEVICE_KEY_INVALID');
  });

  it('现场角色不能管理设备', async () => {
    const cookie = cookieOf((await loginPacking(DEVICE_B)).headers)!;
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/users/${packingId}/devices`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(403);
  });
});