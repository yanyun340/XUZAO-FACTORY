import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, requireAdmin } from '../auth/guards.ts';
import { prisma } from '../db.ts';
import type { Prisma } from '../generated/prisma/client.ts';
import { ok } from '../http/respond.ts';
import {
  diffRecords,
  formatChanges,
  maskRecord,
} from '../lib/audit-diff.ts';
import { buildWorkbook, sendXlsx, type XlsxColumn } from '../lib/export-workbook.ts';
import { shanghaiDateKey } from '../lib/time.ts';

const filterSchema = z.object({
  action: z.string().trim().max(80).optional(),
  resourceType: z.string().trim().max(60).optional(),
  resourceId: z.string().trim().max(80).optional(),
  actorId: z.string().uuid().optional(),
  keyword: z.string().trim().max(80).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
});

const querySchema = filterSchema.extend({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

type AuditFilter = z.infer<typeof filterSchema>;

function buildWhere(query: AuditFilter): Prisma.AuditLogWhereInput {
  return {
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
}

function timestamp(date: Date): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
}

const EXPORT_COLUMNS: XlsxColumn[] = [
  { header: '时间', width: 20 },
  { header: '操作', width: 24 },
  { header: '资源类型', width: 16 },
  { header: '资源 ID', width: 38 },
  { header: '操作者', width: 16 },
  { header: '结果', width: 10 },
  { header: '请求 ID', width: 38 },
  { header: '变化', width: 70 },
];

const MAX_EXPORT_ROWS = 10_000;

/** 审计日志只读：管理员用来追查"谁在什么时候改了什么"。 */
export async function auditRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/audit-logs', { preHandler: [authenticate, requireAdmin] }, async (request, reply) => {
    const query = querySchema.parse(request.query);
    const where = buildWhere(query);

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
      rows.map((row) => {
        const before = maskRecord(row.beforeJson);
        const after = maskRecord(row.afterJson);
        return {
          id: row.id,
          requestId: row.requestId,
          action: row.action,
          resourceType: row.resourceType,
          resourceId: row.resourceId,
          result: row.result,
          actorName: row.actor?.displayName ?? null,
          actorUsername: row.actor?.username ?? null,
          before,
          after,
          changes: diffRecords(before, after),
          createdAt: row.createdAt.toISOString(),
        };
      }),
      200,
      {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
      },
    );
  });

  // R23F：审计导出，筛选条件与列表一致；仍然只有管理员可用。
  app.get(
    '/api/v1/audit-logs/export.xlsx',
    { preHandler: [authenticate, requireAdmin] },
    async (request, reply) => {
      const query = filterSchema.parse(request.query);

      const rows = await prisma.auditLog.findMany({
        where: buildWhere(query),
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: MAX_EXPORT_ROWS,
        include: { actor: { select: { displayName: true, username: true } } },
      });

      const workbook = buildWorkbook({
        sheetName: '审计日志',
        columns: EXPORT_COLUMNS,
        rows: rows.map((row) => {
          const changes = diffRecords(maskRecord(row.beforeJson), maskRecord(row.afterJson));
          return [
            timestamp(row.createdAt),
            row.action,
            row.resourceType,
            row.resourceId,
            row.actor?.displayName ?? '',
            row.result,
            row.requestId,
            formatChanges(changes),
          ];
        }),
      });

      return sendXlsx(reply, workbook, `xuzao-audit-${shanghaiDateKey()}.xlsx`);
    },
  );

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