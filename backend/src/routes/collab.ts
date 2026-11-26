import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, authContext, requireAdmin } from '../auth/guards.ts';
import { prisma } from '../db.ts';
import { activeDecision, isActive } from '../domain/flow.ts';
import { canSeeMoney, toOrderSummary } from '../domain/orders.ts';
import { Errors } from '../errors.ts';
import type { Prisma } from '../generated/prisma/client.ts';
import { NotificationCategory } from '../generated/prisma/enums.ts';
import { ok } from '../http/respond.ts';
import { runDueDateReminders } from '../jobs/due-reminders.ts';
import { writeAudit } from '../lib/audit.ts';
import { recordEvent } from '../lib/events.ts';
import { replayHeaders, runIdempotent } from '../lib/idempotency.ts';
import { NOTIFICATION_CATEGORIES } from '../lib/notification-categories.ts';

const pageSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  unread: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
  category: z.nativeEnum(NotificationCategory).optional(),
});

const idParam = z.object({ id: z.string().uuid('ID 不合法') });


export async function collabRoutes(app: FastifyInstance): Promise<void> {
  // ---------- 通知 ----------
  app.get('/api/v1/notifications', { preHandler: authenticate }, async (request, reply) => {
    const auth = authContext(request);
    const query = pageSchema.parse(request.query);
    const where = {
      recipientId: auth.user.id,
      ...(query.unread ? { readAt: null } : {}),
      ...(query.category ? { category: query.category } : {}),
    };

    const [total, unread, rows] = await prisma.$transaction([
      prisma.notification.count({ where }),
      prisma.notification.count({
        where: {
          recipientId: auth.user.id,
          readAt: null,
          ...(query.category ? { category: query.category } : {}),
        },
      }),
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
        category: row.category,
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
    const [unread, total, categoryRows] = await prisma.$transaction([
      prisma.notification.count({ where: { recipientId: auth.user.id, readAt: null } }),
      prisma.notification.count({ where: { recipientId: auth.user.id } }),
      prisma.$queryRaw<Array<{ category: string; total: bigint; unread: bigint }>>`
        SELECT
          "category"::text AS category,
          COUNT(*)::bigint AS total,
          COUNT(*) FILTER (WHERE "readAt" IS NULL)::bigint AS unread
        FROM "notifications"
        WHERE "recipientId" = ${auth.user.id}::uuid
        GROUP BY "category"
      `,
    ]);

    const byCategory: Record<string, { total: number; unread: number }> = {};
    for (const category of NOTIFICATION_CATEGORIES) {
      byCategory[category] = { total: 0, unread: 0 };
    }
    for (const row of categoryRows) {
      byCategory[row.category] = { total: Number(row.total), unread: Number(row.unread) };
    }

    // 设备审批与通知角标是两条线：通知点过「已读」后，设备仍可能停在待批准。
    // 所以这里以设备表为准，管理员批准前一直可见；排除自己的设备，避免自扰。
    const pendingDevices =
      auth.user.role === 'ADMIN'
        ? await prisma.device.count({
            where: { status: 'PENDING', userId: { not: auth.user.id } },
          })
        : 0;

    return ok(reply, { unread, total, byCategory, pendingDevices });
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

  // ---------- 看板（R21F：负责人 / 时间筛选 + 生产、库存、发货指标） ----------
  const dashboardQuerySchema = z.object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '起始日期必须是 YYYY-MM-DD').optional(),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '结束日期必须是 YYYY-MM-DD').optional(),
    ownerId: z.string().uuid().optional(),
  });

  app.get('/api/v1/dashboard', { preHandler: authenticate }, async (request, reply) => {
    const auth = authContext(request);
    const query = dashboardQuerySchema.parse(request.query);

    const from = query.from ? new Date(`${query.from}T00:00:00+08:00`) : null;
    const to = query.to ? new Date(`${query.to}T23:59:59.999+08:00`) : null;
    const where: Prisma.OrderWhereInput = {
      ...(query.ownerId ? { ownerId: query.ownerId } : {}),
      ...(from || to
        ? {
            createdAt: {
              ...(from ? { gte: from } : {}),
              ...(to ? { lte: to } : {}),
            },
          }
        : {}),
    };

    const now = Date.now();
    const sevenDaysAgo = new Date(now - 7 * 86_400_000);
    const fourteenDaysAgo = new Date(now - 14 * 86_400_000);

    const [
      statusRows,
      recentOrders,
      orderItems,
      purchaseItems,
      feedbacks,
      platingOrders,
      createdRecent,
      createdPrevious,
      completedRecent,
      completedPrevious,
      productions,
      partStock,
      productStock,
      shipments,
      owners,
    ] = await Promise.all([
      prisma.order.groupBy({
        by: ['status'],
        where,
        orderBy: { status: 'asc' },
        _count: { _all: true },
      }),
      prisma.order.findMany({
        where,
        include: { items: true, owner: { select: { displayName: true } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 5,
      }),
      prisma.orderItem.findMany({
        where: { order: where },
        select: { quantity: true, unitPrice: true },
      }),
      prisma.purchaseItem.findMany({
        where: { purchaseOrder: { order: where } },
        select: { quantity: true, unitPrice: true },
      }),
      prisma.productionFeedback.findMany({
        // R12F：作废反馈不计入看板产量与生产成本。
        where: { productionOrder: { order: where }, voidedAt: null },
        select: { quantity: true, productionOrder: { select: { unitPrice: true } } },
      }),
      prisma.platingOrder.findMany({
        where: { order: where, status: 'RECEIVED' },
        select: { quantity: true, unitPrice: true },
      }),
      prisma.order.count({ where: { AND: [where, { createdAt: { gte: sevenDaysAgo } }] } }),
      prisma.order.count({
        where: { AND: [where, { createdAt: { gte: fourteenDaysAgo, lt: sevenDaysAgo } }] },
      }),
      prisma.order.count({ where: { AND: [where, { completedAt: { gte: sevenDaysAgo } }] } }),
      prisma.order.count({
        where: { AND: [where, { completedAt: { gte: fourteenDaysAgo, lt: sevenDaysAgo } }] },
      }),
      prisma.productionOrder.findMany({
        where: { order: where },
        select: {
          departmentId: true,
          department: { select: { name: true } },
          quantity: true,
          // R12F：生产看板只统计未作废的反馈。
          feedbacks: { where: { voidedAt: null }, select: { quantity: true } },
        },
      }),
      prisma.partInventory.aggregate({ _sum: { quantity: true } }),
      prisma.productInventory.aggregate({ _sum: { quantity: true } }),
      prisma.shipmentRecord.findMany({
        // R12F：作废发货不计入发货完成率。
        where: { order: where, voidedAt: null },
        select: { quantity: true },
      }),
      prisma.adminUser.findMany({
        where: { active: true, role: 'ADMIN' },
        select: { id: true, displayName: true },
        orderBy: { displayName: 'asc' },
      }),
    ]);

    const statusCounts: Record<string, number> = {};
    for (const row of statusRows) statusCounts[row.status] = row._count._all;

    const sales = orderItems.reduce(
      (sum, item) => sum + Number(item.unitPrice) * item.quantity,
      0,
    );
    const purchaseCost = purchaseItems.reduce(
      (sum, item) => sum + Number(item.unitPrice) * item.quantity,
      0,
    );
    const productionCost = feedbacks.reduce(
      (sum, feedback) =>
        sum + Number(feedback.productionOrder.unitPrice) * feedback.quantity,
      0,
    );
    const platingCost = platingOrders.reduce(
      (sum, plating) => sum + Number(plating.unitPrice) * plating.quantity,
      0,
    );
    const profit = sales - purchaseCost - productionCost - platingCost;

    const percentDelta = (recent: number, previous: number): number | null =>
      previous === 0 ? null : Math.round(((recent - previous) / previous) * 100);

    const board = new Map<
      string,
      { departmentId: string; departmentName: string; tasks: number; plannedQty: number; completedQty: number }
    >();
    for (const production of productions) {
      const entry = board.get(production.departmentId) ?? {
        departmentId: production.departmentId,
        departmentName: production.department.name,
        tasks: 0,
        plannedQty: 0,
        completedQty: 0,
      };
      entry.tasks += 1;
      entry.plannedQty += production.quantity;
      entry.completedQty += production.feedbacks.reduce((sum, f) => sum + f.quantity, 0);
      board.set(production.departmentId, entry);
    }

    const orderQty = orderItems.reduce((sum, item) => sum + item.quantity, 0);
    const shippedQty = shipments.reduce((sum, record) => sum + record.quantity, 0);

    return ok(reply, {
      filters: {
        from: query.from ?? null,
        to: query.to ?? null,
        ownerId: query.ownerId ?? null,
      },
      owners,
      statusCounts,
      totalOrders: Object.values(statusCounts).reduce((sum, value) => sum + value, 0),
      production: {
        tasks: productions.length,
        completedFeedback: feedbacks.reduce((sum, feedback) => sum + feedback.quantity, 0),
      },
      productionBoard: [...board.values()],
      inventory: {
        parts: partStock._sum.quantity ?? 0,
        products: productStock._sum.quantity ?? 0,
      },
      shipping: {
        orderQty,
        shippedQty,
        // 保留一位小数：整数四舍五入会把 9.25% 显示成 9%，看起来像算错。
        completionPercent:
          orderQty === 0 ? '0.0' : ((shippedQty / orderQty) * 100).toFixed(1),
      },
      inflow: {
        createdRecent7d: createdRecent,
        createdPrevious7d: createdPrevious,
        createdDeltaPercent: percentDelta(createdRecent, createdPrevious),
        completedRecent7d: completedRecent,
        completedPrevious7d: completedPrevious,
        completedDeltaPercent: percentDelta(completedRecent, completedPrevious),
      },
      // 金额属于字段级权限：非管理员连金额字段都不返回，而不是返回 0 让前端隐藏。
      profit: canSeeMoney(auth.user.role)
        ? {
            sales: sales.toFixed(2),
            purchaseCost: purchaseCost.toFixed(2),
            productionCost: productionCost.toFixed(2),
            platingCost: platingCost.toFixed(2),
            profit: profit.toFixed(2),
            marginPercent: sales === 0 ? '0.00' : ((profit / sales) * 100).toFixed(2),
          }
        : null,
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

  // ---------- 异常上报与处置（R22F） ----------
  const EXCEPTION_CATEGORIES = ['QUALITY', 'MATERIAL', 'EQUIPMENT', 'SCHEDULE', 'OTHER'] as const;
  const EXCEPTION_STATUSES = ['OPEN', 'IN_PROGRESS', 'WAITING_QC', 'RESOLVED', 'CLOSED'] as const;

  /**
   * 只允许向前推进；不允许从已关闭回退，也不允许跳步。
   * WAITING_QC 只能由「下发复核」进入，只能凭通过的质检记录离开。
   */
  const EXCEPTION_TRANSITIONS: Record<string, readonly string[]> = {
    OPEN: ['IN_PROGRESS', 'CLOSED'],
    IN_PROGRESS: ['WAITING_QC', 'RESOLVED', 'CLOSED'],
    WAITING_QC: ['RESOLVED'],
    RESOLVED: ['CLOSED'],
    CLOSED: [],
  };

  const exceptionSchema = z
    .object({
      orderId: z.string().uuid().optional(),
      productionOrderId: z.string().uuid().optional(),
      category: z.enum(EXCEPTION_CATEGORIES).default('OTHER'),
      description: z.string().trim().min(4, '请至少描述 4 个字').max(500),
    })
    .refine((value) => value.orderId || value.productionOrderId, {
      message: '必须关联订单或生产任务',
    });

  const exceptionQuerySchema = z.object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
    status: z.enum(EXCEPTION_STATUSES).optional(),
    category: z.enum(EXCEPTION_CATEGORIES).optional(),
    handlerId: z.string().uuid().optional(),
    keyword: z.string().trim().max(100).optional(),
  });

  const exceptionPatchSchema = z
    .object({
      status: z.enum(EXCEPTION_STATUSES).optional(),
      handlerId: z.string().uuid().nullable().optional(),
      expectedAt: z.string().datetime({ offset: true }).nullable().optional(),
      resolution: z.string().trim().min(2).max(500).nullable().optional(),
      /** 质量异常明确不走质检时的留痕豁免，必须同时填写处理说明。 */
      waiveQc: z.boolean().optional(),
    })
    .refine((value) => Object.keys(value).length > 0, { message: '没有需要修改的字段' });

  const exceptionReviewSchema = z.object({
    expectedAt: z.string().datetime({ offset: true }).nullable().optional(),
  });

  function toExceptionItem(row: {
    id: string;
    orderId: string | null;
    productionOrderId: string | null;
    category: string;
    description: string;
    status: string;
    expectedAt: Date | null;
    resolvedAt: Date | null;
    resolution: string | null;
    createdAt: Date;
    updatedAt: Date;
    qcRecordId: string | null;
    qcWaived: boolean;
    order: { orderNo: string } | null;
    reporter: { displayName: string };
    handler: { id: string; displayName: string } | null;
    qcRecord: {
      id: string;
      round: number;
      inspectedQty: number;
      qualifiedQty: number;
      unqualifiedQty: number;
      decision: {
        decision: string;
        releasedQty: number;
        scrapQty: number;
      } | null;
    } | null;
  }) {
    return {
      id: row.id,
      orderId: row.orderId,
      orderNo: row.order?.orderNo ?? null,
      productionOrderId: row.productionOrderId,
      category: row.category,
      description: row.description,
      status: row.status,
      handlerId: row.handler?.id ?? null,
      handlerName: row.handler?.displayName ?? null,
      expectedAt: row.expectedAt?.toISOString() ?? null,
      resolvedAt: row.resolvedAt?.toISOString() ?? null,
      resolution: row.resolution,
      qcRecordId: row.qcRecordId,
      qcWaived: row.qcWaived,
      qc: row.qcRecord
        ? {
            recordId: row.qcRecord.id,
            round: row.qcRecord.round,
            inspectedQty: row.qcRecord.inspectedQty,
            qualifiedQty: row.qcRecord.qualifiedQty,
            unqualifiedQty: row.qcRecord.unqualifiedQty,
            result: row.qcRecord.decision?.decision ?? null,
            releasedQty: row.qcRecord.decision?.releasedQty ?? 0,
            scrapQty: row.qcRecord.decision?.scrapQty ?? 0,
          }
        : null,
      reporterName: row.reporter.displayName,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  const exceptionInclude = {
    reporter: { select: { displayName: true } },
    handler: { select: { id: true, displayName: true } },
    order: { select: { orderNo: true } },
    qcRecord: {
      select: {
        id: true,
        round: true,
        inspectedQty: true,
        qualifiedQty: true,
        unqualifiedQty: true,
        decision: { select: { decision: true, releasedQty: true, scrapQty: true } },
      },
    },
  } as const;

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
          category: body.category,
          description: body.description,
          status: 'OPEN',
        },
        include: exceptionInclude,
      });

      await writeAudit(tx, {
        requestId: request.id,
        actorId: auth.user.id,
        action: 'exception.report',
        resourceType: 'exception',
        resourceId: exception.id,
        after: {
          orderId,
          category: body.category,
          status: 'OPEN',
          description: body.description.slice(0, 80),
        },
      });

      // 现场异常要立刻让管理员知道；分类用于通知中心的“异常”页签。
      const admins = await tx.adminUser.findMany({
        where: { active: true, role: 'ADMIN' },
        select: { id: true },
      });
      if (admins.length > 0) {
        await tx.notification.createMany({
          data: admins.map((admin) => ({
            eventType: 'EXCEPTION_REPORTED',
            category: 'EXCEPTION' as const,
            title: `现场异常 · ${exception.order?.orderNo ?? '未关联订单'}`,
            body: body.description.slice(0, 120),
            recipientId: admin.id,
            orderId,
            dedupeKey: `exception:${exception.id}:OPEN:${admin.id}`,
          })),
          skipDuplicates: true,
        });
      }

      return exception;
    });

    return ok(reply, toExceptionItem(created), 201);
  });

  app.get('/api/v1/exceptions', { preHandler: [authenticate, requireAdmin] }, async (request, reply) => {
    const query = exceptionQuerySchema.parse(request.query);
    const where: Prisma.TabletExceptionWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.category ? { category: query.category } : {}),
      ...(query.handlerId ? { handlerId: query.handlerId } : {}),
      ...(query.keyword
        ? { description: { contains: query.keyword, mode: 'insensitive' } }
        : {}),
    };

    const [total, rows] = await prisma.$transaction([
      prisma.tabletException.count({ where }),
      prisma.tabletException.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: exceptionInclude,
      }),
    ]);

    return ok(reply, rows.map(toExceptionItem), 200, {
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
    });
  });

  app.patch(
    '/api/v1/exceptions/:id',
    { preHandler: [authenticate, requireAdmin] },
    async (request, reply) => {
      const auth = authContext(request);
      const { id } = idParam.parse(request.params);
      const body = exceptionPatchSchema.parse(request.body);

      if (body.handlerId) {
        const handler = await prisma.adminUser.findUnique({ where: { id: body.handlerId } });
        if (!handler || !handler.active) {
          throw Errors.validation('处理人不存在或已停用', [
            { path: 'handlerId', message: '处理人无效' },
          ]);
        }
      }

      const updated = await prisma.$transaction(async (tx) => {
        const current = await tx.tabletException.findUnique({
          where: { id },
          include: exceptionInclude,
        });
        if (!current) throw Errors.notFound('异常记录不存在', 'EXCEPTION_NOT_FOUND');

        const nextStatus = body.status ?? current.status;
        const statusChanged = nextStatus !== current.status;

        // WAITING_QC 是「已下发复核」的系统状态，不能靠 PATCH 手填，
        // 否则又变成了一条自由改状态的旁路。
        if (body.status === 'WAITING_QC') {
          throw Errors.conflict(
            'EXCEPTION_REVIEW_REQUIRED',
            '请使用「下发复核」按钮，由系统关联质检记录',
          );
        }

        if (statusChanged) {
          const allowed = EXCEPTION_TRANSITIONS[current.status] ?? [];
          if (!allowed.includes(nextStatus)) {
            throw Errors.conflict(
              `EXCEPTION_STATUS_CONFLICT`,
              `异常状态不能从 ${current.status} 变为 ${nextStatus}`,
            );
          }
          if (nextStatus === 'RESOLVED') {
            const resolution = body.resolution ?? current.resolution;
            if (!resolution) {
              throw Errors.validation('标记解决时必须填写处理说明', [
                { path: 'resolution', message: '缺少处理说明' },
              ]);
            }
            // 质量异常要有凭证：关联质检必须 PASS；没有关联质检时只能显式留痕豁免。
            if (current.qcRecordId) {
              const qc = await tx.qCRecord.findUnique({
                where: { id: current.qcRecordId },
                include: { decision: true },
              });
              // R12F：作废的质检记录不能充当解决凭证。
              if (!qc || !isActive(qc) || activeDecision(qc)?.decision !== 'PASS') {
                throw Errors.conflict(
                  'EXCEPTION_QC_NOT_PASSED',
                  '关联质检尚未通过，不能标记解决',
                );
              }
            } else if (current.category === 'QUALITY' && !body.waiveQc) {
              throw Errors.conflict(
                'EXCEPTION_QC_REQUIRED',
                '质量异常需先下发复核并取得 PASS；确不涉及质检时请勾选留痕豁免',
              );
            }
          }
        }

        const saved = await tx.tabletException.update({
          where: { id },
          data: {
            ...(body.status ? { status: body.status } : {}),
            ...(body.handlerId !== undefined ? { handlerId: body.handlerId } : {}),
            ...(body.expectedAt !== undefined
              ? { expectedAt: body.expectedAt ? new Date(body.expectedAt) : null }
              : {}),
            ...(body.resolution !== undefined ? { resolution: body.resolution } : {}),
            ...(body.waiveQc === true &&
            !current.qcRecordId &&
            statusChanged &&
            nextStatus === 'RESOLVED'
              ? { qcWaived: true }
              : {}),
            ...(statusChanged && nextStatus === 'RESOLVED' ? { resolvedAt: new Date() } : {}),
          },
          include: exceptionInclude,
        });

        await writeAudit(tx, {
          requestId: request.id,
          actorId: auth.user.id,
          action: 'exception.update',
          resourceType: 'exception',
          resourceId: id,
          before: {
            status: current.status,
            handlerId: current.handlerId,
            expectedAt: current.expectedAt?.toISOString() ?? null,
            resolution: current.resolution,
            qcRecordId: current.qcRecordId,
            qcWaived: current.qcWaived,
          },
          after: {
            status: saved.status,
            handlerId: saved.handlerId,
            expectedAt: saved.expectedAt?.toISOString() ?? null,
            resolution: saved.resolution,
            qcRecordId: saved.qcRecordId,
            qcWaived: saved.qcWaived,
          },
        });

        if (statusChanged) {
          const recipients = new Set<string>([current.reporterId]);
          if (saved.handlerId) recipients.add(saved.handlerId);
          await tx.notification.createMany({
            data: [...recipients].map((recipientId) => ({
              eventType: 'EXCEPTION_UPDATED',
              category: 'EXCEPTION' as const,
              title: `异常已更新 · ${saved.status}`,
              body: saved.resolution ?? saved.description.slice(0, 120),
              recipientId,
              orderId: saved.orderId,
              dedupeKey: `exception:${saved.id}:${saved.status}:${recipientId}`,
            })),
            skipDuplicates: true,
          });
        }

        return saved;
      });

      return ok(reply, toExceptionItem(updated));
    },
  );

  // ---------- 异常下发复核（R22F × R09F） ----------
  // 异常单不直接改数量或质检状态：它只把生产任务送入正式质检链，
  // 由品控录入、管理员决策，异常单引用通过后的质检记录作为解决凭证。
  app.post(
    '/api/v1/exceptions/:id/review',
    { preHandler: [authenticate, requireAdmin] },
    async (request, reply) => {
      const auth = authContext(request);
      const { id } = idParam.parse(request.params);
      const body = exceptionReviewSchema.parse(request.body ?? {});

      const outcome = await runIdempotent({
        actorId: auth.user.id,
        operation: 'exception.review',
        key: request.headers['idempotency-key'],
        body: { exceptionId: id, ...body },
        handler: async (tx) => {
          const exception = await tx.tabletException.findUnique({ where: { id } });
          if (!exception) throw Errors.notFound('异常记录不存在', 'EXCEPTION_NOT_FOUND');
          if (exception.status !== 'OPEN' && exception.status !== 'IN_PROGRESS') {
            throw Errors.conflict(
              'EXCEPTION_STATUS_CONFLICT',
              `当前状态 ${exception.status} 不能下发复核`,
            );
          }
          if (!exception.productionOrderId) {
            throw Errors.business(
              '异常未关联生产任务，无法下发复核；可在处理说明中留痕解决',
              'EXCEPTION_NO_PRODUCTION',
            );
          }

          const production = await tx.productionOrder.findUnique({
            where: { id: exception.productionOrderId },
            include: {
              order: true,
              feedbacks: true,
              qcRecords: { include: { decision: true } },
            },
          });
          if (!production) throw Errors.notFound('生产任务不存在', 'PRODUCTION_NOT_FOUND');
          const order = production.order;
          const produced = production.feedbacks.reduce((sum, f) => sum + f.quantity, 0);
          if (produced <= 0) {
            throw Errors.business('生产尚未反馈完成数量，无法下发复核', 'EXCEPTION_NO_PRODUCED_QTY');
          }

          const active = await tx.tabletException.findFirst({
            where: {
              productionOrderId: production.id,
              status: 'WAITING_QC',
              id: { not: id },
            },
          });
          if (active) {
            throw Errors.conflict(
              'EXCEPTION_REVIEW_IN_PROGRESS',
              '该生产任务已有待复核异常，请等该异常解决后再下发',
            );
          }

          // R12F：作废记录与作废决策视同不存在。
          const records = production.qcRecords.filter(isActive);
          if (records.some((record) => !activeDecision(record))) {
            throw Errors.conflict(
              'EXCEPTION_QC_PENDING_DECISION',
              '已有质检结果等待管理员决策，不能重复下发复核',
            );
          }

          const initialInspected = records
            .filter((record) => record.round === 1)
            .reduce((sum, record) => sum + record.inspectedQty, 0);
          const hasInitial = initialInspected > 0;

          if (!hasInitial) {
            // 尚未首检：异常复核等同于把生产任务送入首次质检。
            if (order.status === 'IN_PRODUCTION') {
              await tx.order.update({
                where: { id: order.id },
                data: { status: 'PENDING_QC' },
              });
              await recordEvent(tx, {
                orderId: order.id,
                type: 'QC_DISPATCHED',
                actorId: auth.user.id,
                payload: {
                  productionOrderId: production.id,
                  produced,
                  reason: 'exception_review',
                  exceptionId: id,
                },
                notify: {
                  title: `${order.orderNo} 异常复核已下发质检`,
                  body: `待检数量 ${produced}，等待品控录入结果。`,
                },
              });
            } else if (order.status !== 'PENDING_QC') {
              throw Errors.conflict(
                'EXCEPTION_QC_NOT_AVAILABLE',
                `订单当前状态 ${order.status} 不能发起质检复核`,
              );
            }
          } else {
            // 已首检：只有存在未复检的返工量时才允许复核。
            const reworkPending = records.reduce((total, record) => {
              if (activeDecision(record)?.decision !== 'REWORK') return total;
              const reinspected = records
                .filter((child) => child.parentQcRecordId === record.id)
                .reduce((sum, child) => sum + child.inspectedQty, 0);
              return total + Math.max(0, record.unqualifiedQty - reinspected);
            }, 0);
            if (reworkPending <= 0) {
              throw Errors.business(
                '该生产任务没有待复检的返工量；如需重新检验，请先由管理员对质检记录作返工决策',
                'EXCEPTION_NO_QC_BASIS',
              );
            }
            if (order.status !== 'PENDING_QC') {
              throw Errors.conflict(
                'EXCEPTION_QC_NOT_AVAILABLE',
                `订单当前状态 ${order.status} 不能发起质检复核`,
              );
            }
          }

          const saved = await tx.tabletException.update({
            where: { id },
            data: {
              status: 'WAITING_QC',
              ...(exception.handlerId ? {} : { handlerId: auth.user.id }),
              ...(body.expectedAt !== undefined
                ? { expectedAt: body.expectedAt ? new Date(body.expectedAt) : null }
                : {}),
            },
            include: exceptionInclude,
          });

          await writeAudit(tx, {
            requestId: request.id,
            actorId: auth.user.id,
            action: 'exception.review',
            resourceType: 'exception',
            resourceId: id,
            before: { status: exception.status, qcRecordId: exception.qcRecordId },
            after: {
              status: saved.status,
              productionOrderId: production.id,
              firstInspection: !hasInitial,
            },
          });

          // 复核任务要进品控的队列，而不是只停留在管理员页面上。
          const qcUsers = await tx.adminUser.findMany({
            where: { role: 'QC', active: true },
            select: { id: true },
          });
          if (qcUsers.length > 0) {
            await tx.notification.createMany({
              data: qcUsers.map((user) => ({
                eventType: 'EXCEPTION_REVIEWED',
                category: 'EXCEPTION' as const,
                title: `复核任务 · ${saved.order?.orderNo ?? '未关联订单'}`,
                body: exception.description.slice(0, 120),
                recipientId: user.id,
                orderId: exception.orderId,
                dedupeKey: `exception:${id}:REVIEW:${user.id}`,
              })),
              skipDuplicates: true,
            });
          }

          return { status: 200, data: toExceptionItem(saved), resourceId: id };
        },
      });

      reply.headers(replayHeaders(outcome.replayed));
      return ok(reply, outcome.data);
    },
  );
}