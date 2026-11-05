import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL 未配置'),
  TEST_DATABASE_URL: z.string().optional(),
  APP_ORIGIN: z.string().default('http://localhost:5173'),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(168),
  COOKIE_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  SEED_DEMO_PASSWORD: z.string().min(8).optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  UPLOAD_DIR: z.string().optional(),
});

const env = envSchema.parse(process.env);

/**
 * 测试必须连接隔离数据库。
 * 这里做硬性校验，避免误把 TEST_DATABASE_URL 指向开发库后跑清库脚本。
 */
function resolveDatabaseUrl(): string {
  if (env.NODE_ENV !== 'test') return env.DATABASE_URL;
  if (!env.TEST_DATABASE_URL) {
    throw new Error('NODE_ENV=test 时必须配置 TEST_DATABASE_URL');
  }
  const databaseName = new URL(env.TEST_DATABASE_URL).pathname.replace(/^\//, '');
  if (!/test/i.test(databaseName)) {
    throw new Error(`测试数据库名称必须包含 test，当前为 "${databaseName}"`);
  }
  return env.TEST_DATABASE_URL;
}

export const config = {
  nodeEnv: env.NODE_ENV,
  isProduction: env.NODE_ENV === 'production',
  isTest: env.NODE_ENV === 'test',
  host: env.HOST,
  port: env.PORT,
  databaseUrl: resolveDatabaseUrl(),
  appOrigin: env.APP_ORIGIN,
  sessionTtlHours: env.SESSION_TTL_HOURS,
  cookieSecure: env.COOKIE_SECURE,
  seedDemoPassword: env.SEED_DEMO_PASSWORD,
  logLevel: env.LOG_LEVEL,
  uploadDir: env.UPLOAD_DIR ?? 'storage/uploads',
  sessionCookieName: 'xuzao_session',
} as const;

export type Config = typeof config;