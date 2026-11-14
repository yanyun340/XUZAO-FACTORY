import { access, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.ts';
import { pingDatabase, prisma } from '../db.ts';
import { fail, ok } from '../http/respond.ts';

interface ReadyCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

async function checkMigrations(): Promise<ReadyCheck> {
  try {
    const rows = await prisma.$queryRaw<
      Array<{ pending: bigint; failed: bigint }>
    >`
      SELECT
        COUNT(*) FILTER (WHERE "finished_at" IS NULL AND "rolled_back_at" IS NULL)::bigint AS pending,
        COUNT(*) FILTER (WHERE "finished_at" IS NULL AND "rolled_back_at" IS NOT NULL)::bigint AS failed
      FROM "_prisma_migrations"
    `;
    const row = rows[0] ?? { pending: 0n, failed: 0n };
    const ok = Number(row.pending) === 0 && Number(row.failed) === 0;
    return {
      name: 'migrations',
      ok,
      detail: ok ? 'up to date' : `${row.pending} pending / ${row.failed} failed`,
    };
  } catch (error) {
    return {
      name: 'migrations',
      ok: false,
      detail: error instanceof Error ? error.message : 'migration table unavailable',
    };
  }
}

async function checkUploadDir(): Promise<ReadyCheck> {
  try {
    const root = path.resolve(process.cwd(), config.uploadDir);
    await mkdir(root, { recursive: true });
    await access(root, constants.W_OK);
    return { name: 'uploads', ok: true, detail: root };
  } catch (error) {
    return {
      name: 'uploads',
      ok: false,
      detail: error instanceof Error ? error.message : 'upload dir not writable',
    };
  }
}

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  /** 存活探针：进程还在、数据库能 ping 通。 */
  app.get('/api/v1/health', async (request, reply) => {
    try {
      await pingDatabase();
      return ok(reply, {
        status: 'ok',
        database: 'up',
        time: new Date().toISOString(),
        requestId: request.id,
      });
    } catch (error) {
      request.log.error({ err: error }, 'health.database_unavailable');
      return fail(reply, 503, 'DATABASE_UNAVAILABLE', '数据库不可用');
    }
  });

  /** 就绪探针（R26F）：迁移已应用、上传目录可写，才允许接流量。 */
  app.get('/api/v1/ready', async (request, reply) => {
    const database = await pingDatabase()
      .then(() => ({ name: 'database', ok: true }) satisfies ReadyCheck)
      .catch((error: unknown) => ({
        name: 'database',
        ok: false,
        detail: error instanceof Error ? error.message : 'database unavailable',
      }));

    const checks = [database, await checkMigrations(), await checkUploadDir()];
    const ready = checks.every((check) => check.ok);

    if (!ready) {
      request.log.error({ checks }, 'ready.failed');
      return fail(reply, 503, 'NOT_READY', '服务尚未就绪', { checks });
    }

    return ok(reply, {
      status: 'ready',
      time: new Date().toISOString(),
      requestId: request.id,
      checks,
    });
  });
}