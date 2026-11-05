import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, authContext, requireAdmin } from '../auth/guards.ts';
import { prisma } from '../db.ts';
import { toOrderSummary } from '../domain/orders.ts';
import { Errors } from '../errors.ts';
import { ok } from '../http/respond.ts';
import { runDueDateReminders } from '../jobs/due-reminders.ts';
import { writeAudit } from '../lib/audit.ts';

const pageSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  unread: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
});

const idParam = z.object({ id: z.string().uuid('ID 不合法') });

interface StatusRow {
  status: string;
  count: bigint;
}

export async function collabRoutes(app: FastifyInstance): Promise<void> {
  // ---------- 通知 ----------
  app.get('/api/v1/notifications', { preHandler: authenticate }, async (request, reply) => {
    const auth = authContext(request);
    const query = pageSchema.parse(request.query);
    const where = {
      recipientId: auth.user.id,
      ...(query.unread ? { readAt: null } : {}),
    };

    const [total, unread, rows] = await prisma.$transaction([
      prisma.notification.count({ where }),
      prisma.notification.count({ where: { recipientId: auth.user.id, readAt: null } }),
      prisma.notification.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);

    return ok(
      reply,
      rows.map((row) => ({
        id: row.id,
        eventType: row.eventType,
        title: row.title,
        body: row.body,
        orderId: row.orderId,
        readAt: row.readAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
      })),
      200,
      {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
        unread,
      },
    );
  });

  app.get('/api/v1/notifications/summary', { preHandler: authenticate }, async (request, reply) => {
    const auth = authContext(request);
    const [unread, total] = await prisma.$transaction([
      prisma.notification.count({ where: { recipientId: auth.user.id, readAt: null } }),
      prisma.notification.count({ where: { recipientId: auth.user.id } }),
    ]);
    return ok(reply, { unread, total });
  });

  app.post('/api/v1/notifications/:id/read', { preHandler: authenticate }, async (request, reply) => {
    const auth = authContext(request);
    const { id } = idParam.parse(request.params);

    const notification = await prisma.notification.findUnique({ where: { id } });
    if (!notification || notification.recipientId !== auth.user.id) {
      throw Errors.notFound('通知不存在', 'NOTIFICATION_NOT_FOUND');
    }

    // 重复标记返回同一结果，不报错也不重复写入
    const updated = notification.readAt
      ? notification
      : await prisma.notification.update({ where: { id }, data: { readAt: new Date() } });

    return ok(reply, { id: updated.id, readAt: updated.readAt?.toISOString() ?? null });
  });

  app.post('/api/v1/notifications/read-all', { preHandler: authenticate }, async (request, reply) => {
    const auth = authContext(request);
    const result = await prisma.notification.updateMany({
      where: { recipientId: auth.user.id, readAt: null },
      data: { readAt: new Date() },
    });
    return ok(reply, { updated: result.count });
  });

  // ---------- 看板 ----------
  app.get('/api/v1/dashboard', { preHandler: authenticate }, async (request, reply) => {
    const auth = authContext(request);

    const [statusRows, recentOrders, totals, productionRow] = await Promise.all([
      prisma.$queryRaw<StatusRow[]>`
        SELECT status::text AS status, COUNT(*)::bigint AS count
        FROM "orders"
        GROUP BY status`,
      prisma.order.findMany({
        include: { items: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 5,
      }),
      prisma.$queryRaw<Array<{ sales: string; purchase: string; production: string }>>`
        SELECT
          COALESCE((SELECT SUM("unitPrice" * "quantity") FROM "order_items"), 0)::text AS sales,
          COALESCE((SELECT SUM("unitPrice" * "quantity") FROM "purchase_items"), 0)::text AS purchase,
          COALESCE((
            SELECT SUM(p."unitPrice" * f."quantity")
            FROM "production_feedbacks" f
            JOIN "production_orders" p ON p.id = f."productionOrderId"
          ), 0)::text AS production`,
      prisma.$queryRaw<Array<{ tasks: bigint; done: bigint }>>`
        SELECT
          (SELECT COUNT(*) FROM "production_orders")::bigint AS tasks,
          (SELECT COALESCE(SUM("quantity"), 0) FROM "production_feedbacks")::bigint AS done`,
    ]);

    const statusCounts: Record<string, number> = {};
    for (const row of statusRows) statusCounts[row.status] = Number(row.count);

    const totalsRow = totals[0] ?? { sales: '0', purchase: '0', production: '0' };
    const sales = Number(totalsRow.sales);
    const purchaseCost = Number(totalsRow.purchase);
    const productionCost = Number(totalsRow.production);
    const profit = sales - purchaseCost - productionCost;

    return ok(reply, {
      statusCounts,
      totalOrders: Object.values(statusCounts).reduce((sum, value) => sum + value, 0),
      production: {
        tasks: Number(productionRow[0]?.tasks ?? 0),
        completedFeedback: Number(productionRow[0]?.done ?? 0),
      },
      profit: {
        sales: sales.toFixed(2),
        purchaseCost: purchaseCost.toFixed(2),
        productionCost: productionCost.toFixed(2),
        profit: profit.toFixed(2),
        marginPercent: sales === 0 ? '0.00' : ((profit / sales) * 100).toFixed(2),
      },
      recentOrders: recentOrders.map((order) => toOrderSummary(order, auth.user.role)),
    });
  });

  // ---------- 交期提醒（手动补跑） ----------
  app.post(
    '/api/v1/jobs/due-reminders',
    { preHandler: [authenticate, requireAdmin] },
    async (_request, reply) => {
      const result = await runDueDateReminders();
      return ok(reply, result);
    },
  );

  // ---------- 异常上报 ----------
  const exceptionSchema = z
    .object({
      orderId: z.string().uuid().optional(),
      productionOrderId: z.string().uuid().optional(),
      description: z.string().trim().min(4, '请至少描述 4 个字').max(500),
    })
    .refine((value) => value.orderId || value.productionOrderId, {
      message: '必须关联订单或生产任务',
    });

  app.post('/api/v1/exceptions', { preHandler: authenticate }, async (request, reply) => {
    const auth = authContext(request);
    const body = exceptionSchema.parse(request.body);

    let orderId = body.orderId ?? null;
    if (body.productionOrderId) {
      const production = await prisma.productionOrder.findUnique({
        where: { id: body.productionOrderId },
      });
      if (!production) throw Errors.notFound('生产任务不存在', 'PRODUCTION_NOT_FOUND');
      orderId = production.orderId;
    }

    if (orderId) {
      const order = await prisma.order.findUnique({ where: { id: orderId } });
      if (!order) throw Errors.notFound('订单不存在', 'ORDER_NOT_FOUND');
    }

    const created = await prisma.$transaction(async (tx) => {
      const exception = await tx.tabletException.create({
        data: {
          orderId,
          productionOrderId: body.productionOrderId ?? null,
          reporterId: auth.user.id,
          description: body.description,
          status: 'OPEN',
        },
      });
      await writeAudit(tx, {
        requestId: request.id,
        actorId: auth.user.id,
        action: 'exception.report',
        resourceType: 'exception',
        resourceId: exception.id,
        after: { orderId, description: body.description.slice(0, 80) },
      });
      return exception;
    });

    return ok(
      reply,
      {
        id: created.id,
        orderId: created.orderId,
        description: created.description,
        status: created.status,
        createdAt: created.createdAt.toISOString(),
      },
      201,
    );
  });

  app.get('/api/v1/exceptions', { preHandler: [authenticate, requireAdmin] }, async (request, reply) => {
    const query = pageSchema.parse(request.query);
    const [total, rows] = await prisma.$transaction([
      prisma.tabletException.count(),
      prisma.tabletException.findMany({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: {
          reporter: { select: { displayName: true } },
          order: { select: { orderNo: true } },
        },
      }),
    ]);

    return ok(
      reply,
      rows.map((row) => ({
        id: row.id,
        orderId: row.orderId,
        orderNo: row.order?.orderNo ?? null,
        productionOrderId: row.productionOrderId,
        description: row.description,
        status: row.status,
        reporterName: row.reporter.displayName,
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
}