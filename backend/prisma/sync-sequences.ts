/**
 * 修复已有库的取号计数器：把 CUS/SUP/PRT/EMP 的计数器抬到现有最大编号。
 * 幂等，可重复执行。
 *
 *   npm run sync:sequences
 */
import { prisma } from '../src/db.ts';
import { syncCodeSequences } from '../src/lib/sequence-sync.ts';

main()
  .catch((error) => {
    console.error('[sync-sequences] 失败：', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

async function main(): Promise<void> {
  const result = await syncCodeSequences(prisma);
  if (result.length === 0) {
    console.log('[sync-sequences] 没有需要同步的编码');
    return;
  }
  console.table(result);
}