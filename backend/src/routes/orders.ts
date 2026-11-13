import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, authContext, requireAdmin } from '../auth/guards.ts';
import { prisma } from '../db.ts';
import { flowInclude, listFlowInclude } from '../domain/flow.ts';
import { toOrderDetail, toOrderSummaryWithStages } from '../domain/orders.ts';
import { Errors } from '../errors.ts';
import { OrderStatus } from '../generated/prisma/enums.ts';
import { ok } from '../http/respond.ts';
import { writeAudit } from '../lib/audit.ts';
import { replayHeaders, runIdempotent } from '../lib/idempotency.ts';
import { ensureProductInventories } from '../lib/inventory.ts';
import { nextSequence } from '../lib/sequence.ts';
import { isDateOnly, parseDateOnly, shanghaiDateKey } from '../lib/time.ts';

const orderItemSchema = z.object({
  productName: z.string().trim().min(1, '产品名称不能为空').max(100),
  spec: z.string().trim().min(1, '规格不能为空').max(200),
  quantity: z.number().int('数量必须是整数').min(1, '数量必须大于 0').max(10_000_000),
  unitPrice: z
    .string()
    .regex(/^(0|[1-9]\d{0,9})(\.\d{1,2})?$/, '单价必须是非负金额，最多两位小数'),
});

const createOrderSchema = z.object({
  customerId: z.string().uuid('客户 ID 不合法'),
  customerContact: z.string().trim().max(50).optional(),
  dueDate: z.string().refine(isDateOnly, '交期必须是 YYYY-MM-DD 格式的有效日期'),
  remark: z.string().trim().max(500).optional(),
  items: z.array(orderItemSchema).min(1, '至少需要一个产品明细').max(100),
});

const listQuerySchema = z.object({
  status: z.nativeEnum(OrderStatus).optional(),
  keyword: z.string().trim().max(100).optional(),
  customerId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

const idParamSchema = z.object({ id: z.string().uuid('订单 ID 不合法') });

async function nextOrderNo(tx: Parameters<typeof nextSequence>[0]): Promise<string> {
  const dateKey = shanghaiDateKey().replaceAll('-', '');
  const value = await nextSequence(tx, `order:${dateKey}`);
  return `XZ-${dateKey}-${String(value).padStart(4, '0')}`;
}

export async function orderRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/orders', { preHandler: authenticate }, async (request, reply) => {
    const auth = authContext(request);
    const query = listQuerySchema.parse(request.query);

    const where = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.customerId ? { customerId: query.customerId } : {}),
      ...(query.keyword
        ? {
            OR: [
              { orderNo: { contains: query.keyword, mode: 'insensitive' as const } },
              { customerName: { contains: query.keyword, mode: 'insensitive' as const } },
              {
                items: {
                  some: {
                    productName: { contains: query.keyword, mode: 'insensitive' as const },
                  },
                },
              },
            ],
          }
        : {}),
    };

    const [total, orders] = await prisma.$transaction([
      prisma.order.count({ where }),
      prisma.order.findMany({
        where,
        include: listFlowInclude,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);

    const today = shanghaiDateKey();

    return ok(
      reply,
      orders.map((order) => toOrderSummaryWithStages(order, auth.user.role, today)),
      200,
      {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
      },
    );
  });

  app.get('/api/v1/orders/:id', { preHandler: authenticate }, async (request, reply) => {
    const auth = authContext(request);
    const { id } = idParamSchema.parse(request.params);

    const order = await prisma.order.findUnique({
      where: { id },
      include: flowInclude,
    });

    if (!order) throw Errors.notFound('订单不存在', 'ORDER_NOT_FOUND');

    return ok(
      reply,
      toOrderDetail(order, auth.user.role, auth.user.id, auth.user.departmentId),
    );
  });

  app.post(
    '/api/v1/orders',
    { preHandler: [authenticate, requireAdmin] },
    async (request, reply) => {
      const auth = authContext(request);
      const body = createOrderSchema.parse(request.body);

      const outcome = await runIdempotent({
        actorId: auth.user.id,
        operation: 'order.create',
        key: request.headers['idempotency-key'],
        body,
        handler: async (tx) => {
          const customer = await tx.customer.findUnique({ where: { id: body.customerId } });
          if (!customer || !customer.active) {
            throw Errors.business('客户不存在或已停用', 'CUSTOMER_NOT_FOUND');
          }

          const orderNo = await nextOrderNo(tx);

          const order = await tx.order.create({
            data: {
              orderNo,
              customerId: customer.id,
              customerName: customer.name,
              customerContact: body.customerContact ?? customer.contact,
              dueDate: parseDateOnly(body.dueDate),
              remark: body.remark,
              status: 'PENDING_PURCHASE',
              createdById: auth.user.id,
              items: {
                create: body.items.map((item) => ({
                  productName: item.productName,
                  spec: item.spec,
                  quantity: item.quantity,
                  unitPrice: item.unitPrice,
                })),
              },
            },
            include: {
              items: true,
              createdBy: { select: { displayName: true } },
            },
          });

          // 订单产品登记进商品库存台账（数量保持 0），保证库存页可查
          await ensureProductInventories(tx, body.items);

          await tx.timelineEvent.create({
            data: {
              orderId: order.id,
              type: 'ORDER_CREATED',
              actorId: auth.user.id,
              payload: {
                orderNo: order.orderNo,
                itemCount: order.items.length,
                totalQuantity: order.items.reduce((sum, item) => sum + item.quantity, 0),
              },
            },
          });

          await writeAudit(tx, {
            requestId: request.id,
            actorId: auth.user.id,
            action: 'order.create',
            resourceType: 'order',
            resourceId: order.id,
            after: {
              orderNo: order.orderNo,
              customerId: order.customerId,
              status: order.status,
              itemCount: order.items.length,
            },
          });

          const created = await tx.order.findUniqueOrThrow({
            where: { id: order.id },
            include: flowInclude,
          });

          return {
            status: 201,
            data: toOrderDetail(
              created,
              auth.user.role,
              auth.user.id,
              auth.user.departmentId,
            ),
            resourceId: order.id,
          };
        },
      });

      reply.headers(replayHeaders(outcome.replayed));
      return ok(reply, outcome.data, outcome.replayed ? 200 : 201);
    },
  );
}