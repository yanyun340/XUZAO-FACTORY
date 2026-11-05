import type { FastifyInstance } from 'fastify';
import { pingDatabase } from '../db.ts';
import { fail, ok } from '../http/respond.ts';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
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
}