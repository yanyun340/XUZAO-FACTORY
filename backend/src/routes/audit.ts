import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, requireAdmin } from '../auth/guards.ts';
import { prisma } from '../db.ts';
import type { Prisma } from '../generated/prisma/client.ts';
import { ok } from '../http/respond.ts';

const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  action: z.string().trim().max(80).optional(),
  resourceType: z.string().trim().max(60).optional(),
  resourceId: z.string().trim().max(80).optional(),
  actorId: z.string().uuid().optional(),
  keyword: z.string().trim().max(80).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
});

/** 审计日志只读：管理员用来追查"谁在什么时候改了什么"。 */
export async function auditRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/audit-logs', { preHandler: [authenticate, requireAdmin] }, async (request, reply) => {
    const query = querySchema.parse(request.query);

    const where: Prisma.AuditLogWhereInput = {
      ...(query.action ? { action: query.action } : {}),
      ...(query.resourceType ? { resourceType: query.resourceType } : {}),
      ...(query.resourceId ? { resourceId: query.resourceId } : {}),
      ...(query.actorId ? { actorId: query.actorId } : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
      ...(query.keyword
        ? {
            OR: [
              { action: { contains: query.keyword, mode: 'insensitive' } },
              { resourceType: { contains: query.keyword, mode: 'insensitive' } },
              { requestId: { contains: query.keyword, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [total, rows] = await prisma.$transaction([
      prisma.auditLog.count({ where }),
      prisma.auditLog.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: { actor: { select: { displayName: true, username: true } } },
      }),
    ]);

    return ok(
      reply,
      rows.map((row) => ({
        id: row.id,
        requestId: row.requestId,
        action: row.action,
        resourceType: row.resourceType,
        resourceId: row.resourceId,
        result: row.result,
        actorName: row.actor?.displayName ?? null,
        actorUsername: row.actor?.username ?? null,
        before: row.beforeJson,
        after: row.afterJson,
        createdAt: row.createdAt.toISOString(),
      })),
      200,
      {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
      },
    );
  });

  // 供前端下拉框使用：库里实际出现过的动作与资源类型
  app.get(
    '/api/v1/audit-logs/facets',
    { preHandler: [authenticate, requireAdmin] },
    async (_request, reply) => {
      const [actions, resourceTypes, actors] = await prisma.$transaction([
        prisma.auditLog.findMany({ distinct: ['action'], select: { action: true }, orderBy: { action: 'asc' } }),
        prisma.auditLog.findMany({
          distinct: ['resourceType'],
          select: { resourceType: true },
          orderBy: { resourceType: 'asc' },
        }),
        prisma.adminUser.findMany({
          where: { auditLogs: { some: {} } },
          select: { id: true, displayName: true },
          orderBy: { displayName: 'asc' },
        }),
      ]);

      return ok(reply, {
        actions: actions.map((row) => row.action),
        resourceTypes: resourceTypes.map((row) => row.resourceType),
        actors,
      });
    },
  );
}