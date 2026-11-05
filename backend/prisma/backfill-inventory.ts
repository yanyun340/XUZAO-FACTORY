/**
 * 历史数据补齐：给已存在但还没有库存台账的配件建 0 库存记录。
 * 幂等，可以重复执行。
 *
 *   npm run backfill:inventory
 */
import { prisma } from '../src/db.ts';

async function main() {
  const parts = await prisma.part.findMany({
    where: { inventory: null },
    select: { id: true, code: true, name: true },
  });

  if (parts.length === 0) {
    console.log('所有配件都已有库存台账，无需补齐。');
    return;
  }

  for (const part of parts) {
    await prisma.partInventory.create({ data: { partId: part.id, quantity: 0 } });
    console.log(`+ ${part.code} ${part.name}`);
  }

  console.log(`补齐完成，共 ${parts.length} 个配件。`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });