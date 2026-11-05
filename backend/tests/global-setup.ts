import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { Client } from 'pg';

/**
 * 测试只连隔离库：TEST_DATABASE_URL 必须存在且库名含 test。
 * 启动前跑迁移并清空业务表，保证每次都是确定性的初始状态。
 */
export default async function setup(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('缺少 TEST_DATABASE_URL，测试需要隔离数据库');

  const name = new URL(url).pathname.replace(/^\//, '');
  if (!/test/i.test(name)) {
    throw new Error(`测试库名称必须包含 test，当前为 "${name}"`);
  }

  execFileSync('npx', ['prisma', 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'], {
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'inherit',
    shell: true,
  });

  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const tables = await client.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`,
    );
    if (tables.rows.length > 0) {
      const list = tables.rows.map((row) => `"${row.tablename}"`).join(', ');
      await client.query(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
    }
  } finally {
    await client.end();
  }
}