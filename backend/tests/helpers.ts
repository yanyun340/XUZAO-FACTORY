import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { hashPassword } from '../src/auth/password.ts';
import { prisma } from '../src/db.ts';
import { syncCodeSequences } from '../src/lib/sequence-sync.ts';

export const TEST_PASSWORD = 'Test-pass-2026';

/** 清空隔离库里的业务表，不动迁移记录。 */
export async function resetDb(): Promise<void> {
  const rows = await prisma.$queryRawUnsafe<Array<{ tablename: string }>>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`,
  );
  if (rows.length === 0) return;
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${rows.map((row) => `"${row.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`,
  );
}

export interface Fixtures {
  departments: Record<'PROD' | 'QC' | 'PACK' | 'LOGI', string>;
  employeeId: string;
  customerId: string;
  supplierId: string;
  partId: string;
  users: Record<'admin' | 'logistics' | 'production' | 'qc' | 'packing', string>;
}

/** 最小基础数据：一套部门、五个角色账号、一个客户、一个供应商、一个配件。 */
export async function seedBase(): Promise<Fixtures> {
  const passwordHash = await hashPassword(TEST_PASSWORD);

  const [prod, qc, pack, logi] = await Promise.all([
    prisma.department.create({ data: { code: 'PROD', name: '生产部', category: 'PRODUCTION' } }),
    prisma.department.create({ data: { code: 'QC', name: '品控部', category: 'QC' } }),
    prisma.department.create({ data: { code: 'PACK', name: '包装部', category: 'PACKING' } }),
    prisma.department.create({ data: { code: 'LOGI', name: '物流部', category: 'LOGISTICS' } }),
  ]);

  const employee = await prisma.employee.create({
    data: { code: 'EMP-0001', name: '测试工人', departmentId: prod.id },
  });

  const accounts = [
    { username: 'admin', displayName: '管理员', role: 'ADMIN' as const, departmentId: null },
    { username: 'logistics', displayName: '物流专员', role: 'LOGISTICS' as const, departmentId: logi.id },
    { username: 'production', displayName: '生产主管', role: 'PRODUCTION' as const, departmentId: prod.id },
    { username: 'qc', displayName: '品控专员', role: 'QC' as const, departmentId: qc.id },
    { username: 'packing', displayName: '包装专员', role: 'PACKING' as const, departmentId: pack.id },
  ];

  const users: Record<string, string> = {};
  for (const account of accounts) {
    const user = await prisma.adminUser.create({ data: { ...account, passwordHash } });
    users[account.username] = user.id;
  }

  const customer = await prisma.customer.create({
    data: { code: 'CUS-0001', name: '测试客户', contact: '王工' },
  });
  const supplier = await prisma.supplier.create({
    data: { code: 'SUP-0001', name: '测试供应商' },
  });
  const part = await prisma.part.create({
    data: {
      code: 'PRT-0001',
      name: '测试法兰',
      spec: 'DN50',
      inventory: { create: { quantity: 100 } },
    },
  });

  // 夹具里的编码是写死的，把自动取号计数器抬上去，否则新建第一条就撞唯一键
  await syncCodeSequences(prisma);

  return {
    departments: { PROD: prod.id, QC: qc.id, PACK: pack.id, LOGI: logi.id },
    employeeId: employee.id,
    customerId: customer.id,
    supplierId: supplier.id,
    partId: part.id,
    users: users as Fixtures['users'],
  };
}

export async function createApp(): Promise<FastifyInstance> {
  const app = buildApp();
  await app.ready();
  return app;
}

function firstCookie(headers: Record<string, unknown>): string {
  const raw = headers['set-cookie'];
  const value = Array.isArray(raw) ? raw[0] : String(raw ?? '');
  const cookie = value.split(';')[0] ?? '';
  if (!cookie.includes('=')) throw new Error('登录没有返回会话 Cookie');
  return cookie;
}

export async function login(
  app: FastifyInstance,
  username: string,
  password = TEST_PASSWORD,
): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username, password },
  });
  if (response.statusCode !== 200) {
    throw new Error(`登录失败 ${username}: ${response.statusCode} ${response.body}`);
  }
  return firstCookie(response.headers);
}

export interface ApiCaller {
  (method: string, url: string, payload?: unknown, headers?: Record<string, string>): Promise<{
    status: number;
    body: {
      data?: any;
      meta?: any;
      error?: { code: string; message: string; details?: unknown };
    };
    headers: Record<string, unknown>;
  }>;
}

/** 带会话 Cookie 的注入器，统一返回解析后的 JSON。 */
export function api(app: FastifyInstance, cookie?: string): ApiCaller {
  return async (method, url, payload, headers = {}) => {
    // 写接口要求幂等键，用例里默认自动带一个；需要验证重放时显式传同一个键。
    const isWrite = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(method.toUpperCase());
    const hasKey = Object.keys(headers).some((key) => key.toLowerCase() === 'idempotency-key');
    const idempotencyKey =
      isWrite && !hasKey ? { 'idempotency-key': randomUUID() } : {};

    const response = await app.inject({
      method: method as 'GET',
      url,
      payload: payload as never,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...idempotencyKey,
        ...headers,
      },
    });
    return {
      status: response.statusCode,
      body: response.json(),
      headers: response.headers as Record<string, unknown>,
    };
  };
}