import { unlink } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.ts';
import { prisma } from '../db.ts';

const RETENTION_DAYS = 7;

/**
 * R17F：清理策略。
 * 软删除先保留元数据与审计；超过保留期后删除物理文件，再删除元数据行。
 * 文件不存在视为已清理，不阻塞其余记录。
 */
export async function cleanupDeletedAttachments(
  now = new Date(),
  retentionDays = RETENTION_DAYS,
): Promise<{ scanned: number; removed: number }> {
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000);
  const rows = await prisma.attachment.findMany({
    where: { deletedAt: { not: null, lt: cutoff } },
    select: { id: true, storageKey: true },
    take: 500,
  });

  const uploadRoot = path.resolve(process.cwd(), config.uploadDir);
  let removed = 0;

  for (const row of rows) {
    try {
      await unlink(path.join(uploadRoot, row.storageKey));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await prisma.attachment.delete({ where: { id: row.id } });
    removed += 1;
  }

  return { scanned: rows.length, removed };
}