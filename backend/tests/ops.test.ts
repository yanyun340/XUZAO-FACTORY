import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, createApp, login, resetDb, seedBase } from './helpers.ts';

let app: FastifyInstance;

beforeAll(async () => {
  await resetDb();
  await seedBase();
  app = await createApp();
});

afterAll(async () => {
  await app.close();
});

describe('健康与就绪检查（R26F）', () => {
  it('存活探针返回数据库状态', async () => {
    const response = await api(app)('GET', '/api/v1/health');
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ status: 'ok', database: 'up' });
  });

  it('就绪探针逐项检查数据库、迁移与上传目录', async () => {
    const response = await api(app)('GET', '/api/v1/ready');
    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('ready');

    const checks = response.body.data.checks as Array<{ name: string; ok: boolean }>;
    expect(checks.map((check) => check.name).sort()).toEqual([
      'database',
      'migrations',
      'uploads',
    ]);
    expect(checks.every((check) => check.ok)).toBe(true);
  });

  it('未知接口仍然返回 JSON 错误而不是 HTML', async () => {
    const cookie = await login(app, 'admin');
    const response = await api(app, cookie)('GET', '/api/v1/not-a-real-route');
    expect(response.status).toBe(404);
    expect(response.body.error?.code).toBe('ROUTE_NOT_FOUND');
  });
});