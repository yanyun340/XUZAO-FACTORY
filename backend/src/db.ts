import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.ts';
import { config } from './config.ts';

const adapter = new PrismaPg({
  connectionString: config.databaseUrl,
  max: config.isTest ? 5 : 10,
});

export const prisma = new PrismaClient({
  adapter,
  log: config.isTest ? [] : ['warn', 'error'],
});

/** 健康检查用：确认数据库真实可查询，而不是只看进程存活。 */
export async function pingDatabase(): Promise<void> {
  await prisma.$queryRaw`SELECT 1`;
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}