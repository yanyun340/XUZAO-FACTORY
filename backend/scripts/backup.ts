/**
 * 逻辑备份：把业务表导出成一个带校验和的 JSON 文件。
 * 内嵌的 PostgreSQL 没有 pg_dump，所以用 Prisma 逐表导出，
 * 恢复脚本按外键顺序写回隔离库，最后逐表核对行数。
 *
 *   npm run backup                       # 输出到 backend/backups/
 *   BACKUP_DIR=D:/bak npm run backup
 */
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../src/config.ts';
import { prisma } from '../src/db.ts';
import { assetsDirOf, type BackupAsset } from './backup-format.ts';
import { TABLES, type BackupDb } from './backup-tables.ts';

export interface BackupFile {
  format: 'xuzao-logical-backup';
  version: 1;
  createdAt: string;
  database: string;
  counts: Record<string, number>;
  tables: Record<string, unknown[]>;
  assets?: BackupAsset[];
  checksum: string;
}

export function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export async function collectAssets(
  attachmentRows: Array<{ storageKey?: unknown }>,
  uploadRoot: string,
  assetsDir: string,
): Promise<BackupAsset[]> {
  const assets: BackupAsset[] = [];
  const missing: string[] = [];
  await mkdir(assetsDir, { recursive: true });

  for (const row of attachmentRows) {
    const storageKey = path.basename(String(row.storageKey ?? ''));
    if (!storageKey) continue;
    try {
      const data = await readFile(path.join(uploadRoot, storageKey));
      await copyFile(path.join(uploadRoot, storageKey), path.join(assetsDir, storageKey));
      assets.push({ storageKey, size: data.byteLength, sha256: sha256(data) });
    } catch {
      missing.push(storageKey);
    }
  }

  if (missing.length > 0) {
    throw new Error(`附件文件缺失，拒绝生成不完整备份：${missing.join(', ')}`);
  }
  return assets;
}

export function databaseName(url: string): string {
  return new URL(url).pathname.replace(/^\//, '');
}

/** 校验和只覆盖数据本身，不含 createdAt，同一个库多次导出结果一致。 */
export function payloadChecksum(payload: {
  database: string;
  counts: Record<string, number>;
  tables: Record<string, unknown[]>;
  assets?: BackupAsset[];
}): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

async function main() {
  const db = prisma as unknown as BackupDb;
  const tables: Record<string, unknown[]> = {};
  const counts: Record<string, number> = {};

  for (const table of TABLES) {
    const rows = await db[table.delegate].findMany();
    tables[table.name] = rows;
    counts[table.name] = rows.length;
    console.log(`  ${table.name.padEnd(24)} ${String(rows.length).padStart(5)}`);
  }

  const outDir = path.resolve(process.cwd(), process.env.BACKUP_DIR ?? 'backups');
  await mkdir(outDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(outDir, `xuzao-backup-${stamp}.json`);

  // 附件文件跟数据库一起备份；缺文件直接失败，不产出“看起来完整”的备份。
  const assets = await collectAssets(
    (tables.attachments ?? []) as Array<{ storageKey?: unknown }>,
    path.resolve(process.cwd(), config.uploadDir),
    assetsDirOf(file),
  );

  const payload = {
    format: 'xuzao-logical-backup' as const,
    version: 1 as const,
    createdAt: new Date().toISOString(),
    database: databaseName(process.env.DATABASE_URL ?? ''),
    counts,
    tables,
    assets,
  };

  const checksum = payloadChecksum({
    database: payload.database,
    counts,
    tables,
    assets,
  });
  const backup: BackupFile = { ...payload, checksum };

  await writeFile(file, JSON.stringify(backup, null, 2), 'utf8');

  console.log(`\n备份完成：${file}`);
  console.log(`附件文件：${assets.length} 个（${assetsDirOf(file)}）`);
  console.log(`校验和：${checksum}`);
  console.log(`总行数：${Object.values(counts).reduce((sum, value) => sum + value, 0)}`);
}

main()
  .catch((error) => {
    console.error('[backup] 失败：', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });