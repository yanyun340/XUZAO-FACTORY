/**
 * 把逻辑备份恢复到一个"隔离库"，并逐表核对行数。
 *
 *   npm run restore -- backups/xuzao-backup-2026-11-04T10-00-00.json \
 *     --target "postgresql://postgres:postgres@127.0.0.1:55432/xuzao_restore_verify"
 *
 * 安全约束（按考核要求：备份必须恢复到新库，不能覆盖现有库）：
 *   1. 目标库名必须包含 restore / verify / test 之一；
 *   2. 目标库不能等于 DATABASE_URL 指向的库；
 *   3. 目标库若已有数据，默认拒绝，必须显式加 --force 才会清空（仅限隔离库）。
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PrismaPg } from '@prisma/adapter-pg';
import { Client } from 'pg';
import { PrismaClient } from '../src/generated/prisma/client.ts';
import { assetsDirOf, type BackupAsset } from './backup-format.ts';
import { TABLES, type BackupDb } from './backup-tables.ts';

interface BackupFile {
  format: string;
  version: number;
  createdAt: string;
  database: string;
  counts: Record<string, number>;
  tables: Record<string, unknown[]>;
  assets?: BackupAsset[];
  checksum: string;
}

interface Args {
  file: string;
  target: string;
  force: boolean;
  uploadDir: string;
}

function parseArgs(argv: string[]): Args {
  let file = '';
  let target = process.env.RESTORE_DATABASE_URL ?? '';
  let force = false;
  let uploadDir = process.env.RESTORE_UPLOAD_DIR ?? 'storage/uploads-restore-verify';

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--force') {
      force = true;
    } else if (arg === '--target') {
      target = argv[index + 1] ?? '';
      index += 1;
    } else if (arg.startsWith('--target=')) {
      target = arg.slice('--target='.length);
    } else if (arg === '--upload-dir') {
      uploadDir = argv[index + 1] ?? '';
      index += 1;
    } else if (arg.startsWith('--upload-dir=')) {
      uploadDir = arg.slice('--upload-dir='.length);
    } else if (!arg.startsWith('--') && !file) {
      file = arg;
    }
  }

  if (!file || !target) {
    throw new Error(
      '用法：tsx scripts/restore.ts <备份文件> --target <隔离库连接串> [--upload-dir <隔离附件目录>] [--force]',
    );
  }
  return { file, target, force, uploadDir };
}

function dbNameOf(url: string): string {
  return new URL(url).pathname.replace(/^\//, '');
}

function assertIsolated(targetUrl: string): string {
  const name = dbNameOf(targetUrl);
  const devName = process.env.DATABASE_URL ? dbNameOf(process.env.DATABASE_URL) : '';

  if (!/(restore|verify|test)/i.test(name)) {
    throw new Error(`拒绝执行：目标库 "${name}" 看起来不是隔离库（名字需含 restore/verify/test）`);
  }
  if (devName && name === devName) {
    throw new Error(`拒绝执行：目标库与 DATABASE_URL 相同（${name}）`);
  }
  return name;
}

/** 附件同样只能恢复到隔离目录，不能直接覆盖正在使用的 uploads。 */
function assertIsolatedUploadDir(dir: string): string {
  const target = path.resolve(process.cwd(), dir);
  const source = path.resolve(process.cwd(), process.env.UPLOAD_DIR ?? 'storage/uploads');
  if (target === source) {
    throw new Error('拒绝执行：附件目录与当前 UPLOAD_DIR 相同，恢复必须使用隔离目录');
  }
  if (!/(restore|verify|test)/i.test(target)) {
    throw new Error(`拒绝执行：附件目录 "${target}" 需包含 restore/verify/test`);
  }
  return target;
}

async function restoreAssets(
  backup: BackupFile,
  backupFile: string,
  targetDir: string,
): Promise<number> {
  const assets = backup.assets ?? [];
  if (assets.length === 0) return 0;

  const sourceDir = assetsDirOf(backupFile);
  await mkdir(targetDir, { recursive: true });
  const problems: string[] = [];

  for (const asset of assets) {
    const name = path.basename(asset.storageKey);
    let data: Buffer;
    try {
      data = await readFile(path.join(sourceDir, name));
    } catch {
      problems.push(`${name}: 备份中缺少附件文件`);
      continue;
    }
    const actualHash = createHash('sha256').update(data).digest('hex');
    if (data.byteLength !== asset.size || actualHash !== asset.sha256) {
      problems.push(`${name}: 大小或校验和不一致`);
      continue;
    }
    try {
      await writeFile(path.join(targetDir, name), data, { flag: 'wx' });
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== 'EEXIST') throw error;
      const existing = await readFile(path.join(targetDir, name));
      if (!existing.equals(data)) problems.push(`${name}: 目标目录已存在同名但内容不同的文件`);
    }
  }

  if (problems.length > 0) {
    throw new Error(`附件恢复失败：\n  - ${problems.join('\n  - ')}`);
  }
  console.log(`附件恢复完成：${assets.length} 个文件写入 ${targetDir}`);
  return assets.length;
}

/** 连到同实例的 postgres 库，按需创建目标库。 */
async function ensureDatabaseExists(targetUrl: string, name: string): Promise<boolean> {
  const probe = new Client({ connectionString: targetUrl });
  try {
    await probe.connect();
    await probe.end();
    return false;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== '3D000') throw error;
  }

  const adminUrl = new URL(targetUrl);
  adminUrl.pathname = '/postgres';
  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${name.replace(/"/g, '""')}"`);
    console.log(`已创建隔离库 ${name}`);
  } finally {
    await admin.end();
  }
  return true;
}

function runMigrations(targetUrl: string): void {
  const result = spawnSync('npx', ['prisma', 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'], {
    env: { ...process.env, DATABASE_URL: targetUrl },
    stdio: 'inherit',
    shell: true,
  });
  if (result.status !== 0) {
    throw new Error('prisma migrate deploy 失败');
  }
}

async function tableCount(client: Client, name: string): Promise<number> {
  const result = await client.query(`SELECT COUNT(*)::int AS count FROM "${name}"`);
  return result.rows[0].count as number;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const name = assertIsolated(args.target);
  const uploadDir = assertIsolatedUploadDir(args.uploadDir);

  const raw = await readFile(args.file, 'utf8');
  const backup = JSON.parse(raw) as BackupFile;
  if (backup.format !== 'xuzao-logical-backup' || backup.version !== 1) {
    throw new Error('不是受支持的备份文件格式');
  }

  const { counts, tables, database, assets } = backup;
  const checksum = createHash('sha256')
    .update(JSON.stringify({ database, counts, tables, assets }))
    .digest('hex');
  if (checksum !== backup.checksum) {
    throw new Error(`备份校验和不匹配：期望 ${backup.checksum}，实际 ${checksum}`);
  }
  console.log(`备份校验通过（来源库 ${database}，导出时间 ${backup.createdAt}）`);

  const created = await ensureDatabaseExists(args.target, name);

  const probe = new Client({ connectionString: args.target });
  await probe.connect();
  let existingRows = 0;
  try {
    const present = await probe.query(
      `SELECT COUNT(*)::int AS count FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'orders'`,
    );
    if (present.rows[0].count > 0) {
      existingRows = await tableCount(probe, 'orders');
    }
  } finally {
    await probe.end();
  }

  if (existingRows > 0 && !args.force) {
    throw new Error(`目标库 ${name} 已有 ${existingRows} 条订单数据，拒绝覆盖（确认是隔离库可加 --force）`);
  }

  runMigrations(args.target);

  const client = new Client({ connectionString: args.target });
  await client.connect();
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: args.target, max: 5 }),
  });
  const db = prisma as unknown as BackupDb;

  const problems: string[] = [];
  try {
    if (!created && existingRows > 0) {
      const list = TABLES.map((table) => `"${table.name}"`).join(', ');
      await client.query(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
      console.log('已清空目标库现有数据（--force）');
    }

    for (const table of TABLES) {
      const rows = tables[table.name] ?? [];
      if (rows.length === 0) continue;
      const result = await db[table.delegate].createMany({ data: rows });
      console.log(`  ${table.name.padEnd(24)} ${String(result.count).padStart(5)} / ${counts[table.name]}`);
    }

    for (const table of TABLES) {
      const expected = counts[table.name] ?? 0;
      const actual = await tableCount(client, table.name);
      if (actual !== expected) {
        problems.push(`${table.name}: 期望 ${expected}，实际 ${actual}`);
      }
    }
  } finally {
    await prisma.$disconnect();
    await client.end();
  }

  if (problems.length > 0) {
    console.error('\n行数核对失败：');
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
    return;
  }

  const restoredFiles = await restoreAssets(backup, args.file, uploadDir);
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  console.log(
    `\n恢复完成：${total} 行写入 ${name}，${TABLES.length} 张表行数全部一致；附件 ${restoredFiles} 个已核对。`,
  );
}

main().catch((error) => {
  console.error('[restore] 失败：', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});