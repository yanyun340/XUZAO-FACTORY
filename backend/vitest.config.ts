import 'dotenv/config';
import { defineConfig } from 'vitest/config';

// 测试只能连隔离库：库名必须含 test，且与开发库区分开。
const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) throw new Error('缺少 TEST_DATABASE_URL，测试需要隔离数据库');
const databaseName = new URL(testDatabaseUrl).pathname.replace(/^\//, '');
if (!/test/i.test(databaseName)) {
  throw new Error(`测试数据库名称必须包含 test，当前为 "${databaseName}"`);
}

export default defineConfig({
  test: {
    environment: 'node',
    // 所有用例共用一个隔离库，串行执行，避免互相清库
    fileParallelism: false,
    sequence: { concurrent: false },
    globalSetup: ['./tests/global-setup.ts'],
    // 让 src/config.ts 走进测试分支，并确保 Prisma 客户端连的是测试库
    env: {
      NODE_ENV: 'test',
      TEST_DATABASE_URL: testDatabaseUrl,
      DATABASE_URL: testDatabaseUrl,
    },
    testTimeout: 30_000,
    hookTimeout: 60_000,
    include: ['tests/**/*.test.ts'],
  },
});