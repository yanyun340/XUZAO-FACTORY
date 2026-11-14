import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { authenticate, authContext, requireAdmin } from '../auth/guards.ts';
import { prisma } from '../db.ts';
import { Errors } from '../errors.ts';
import type { Prisma } from '../generated/prisma/client.ts';
import { InventoryKind } from '../generated/prisma/enums.ts';
import { ok } from '../http/respond.ts';
import { writeAudit } from '../lib/audit.ts';
import { replayHeaders, runIdempotent } from '../lib/idempotency.ts';
import {
  adjustPartStock,
  adjustProductStock,
  productKeyOf,
} from '../lib/inventory.ts';

const listSchema = z.object({
  keyword: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

const logQuerySchema = listSchema.extend({
  kind: z.nativeEnum(InventoryKind).optional(),
});

const idParam = z.object({ id: z.string().uuid('ID 不合法') });

const adjustSchema = z.object({
  delta: z
    .number()
    .int('调整数量必须是整数')
    .refine((value) => value !== 0, '调整数量不能为 0')
    .refine((value) => Math.abs(value) <= 1_000_000, '单次调整不能超过 100 万'),
  reason: z.string().trim().min(2, '请填写至少 2 个字的调整原因').max(200),
});

function paged<T>(reply: FastifyReply, items: T[], total: number, page: number, pageSize: number) {
  return ok(reply, items, 200, {
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  });
}

export async function inventoryRoutes(app: FastifyInstance): Promise<void> {
  // ---------- 配件库存 ----------
  app.get('/api/v1/inventory/parts', { preHandler: authenticate }, async (request, reply) => {
    const query = listSchema.parse(request.query);
    const where: Prisma.PartInventoryWhereInput = query.keyword
      ? {
          part: {
            OR: [
              { name: { contains: query.keyword, mode: 'insensitive' } },
              { code: { contains: query.keyword, mode: 'insensitive' } },
              { spec: { contains: query.keyword, mode: 'insensitive' } },
            ],
          },
        }
      : {};

    const [total, rows] = await prisma.$transaction([
      prisma.partInventory.count({ where }),
      prisma.partInventory.findMany({
        where,
        include: { part: { select: { id: true, code: true, name: true, spec: true, active: true } } },
        orderBy: [{ part: { code: 'asc' } }, { id: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);

    return paged(
      reply,
      rows.map((row) => ({
        id: row.id,
        partId: row.partId,
        code: row.part.code,
        name: row.part.name,
        spec: row.part.spec,
        active: row.part.active,
        quantity: row.quantity,
        version: row.version,
        updatedAt: row.updatedAt.toISOString(),
      })),
      total,
      query.page,
      query.pageSize,
    );
  });

  app.post(
    '/api/v1/inventory/parts/:id/adjust',
    { preHandler: [authenticate, requireAdmin] },
    async (request, reply) => {
      const auth = authContext(request);
      const { id } = idParam.parse(request.params);
      const body = adjustSchema.parse(request.body);

      // 把资源 ID 一起放进请求哈希：同一个键打到另一个库存行会被判为不同意图。
      const outcome = await runIdempotent({
        actorId: auth.user.id,
        operation: 'inventory.part.adjust',
        key: request.headers['idempotency-key'],
        body: { id, ...body },
        handler: async (tx) => {
          const adjusted = await adjustPartStock(tx, id, {
            delta: body.delta,
            reason: body.reason,
            operatorId: auth.user.id,
          });

          await writeAudit(tx, {
            requestId: request.id,
            actorId: auth.user.id,
            action: 'inventory.part.adjust',
            resourceType: 'part_inventory',
            resourceId: id,
            before: { quantity: adjusted.before },
            after: { quantity: adjusted.after, delta: body.delta, reason: body.reason },
          });

          return { status: 200, data: adjusted, resourceId: id };
        },
      });

      reply.headers(replayHeaders(outcome.replayed));
      return ok(reply, outcome.data);
    },
  );

  // ---------- 商品库存 ----------
  app.get('/api/v1/inventory/products', { preHandler: authenticate }, async (request, reply) => {
    const query = listSchema.parse(request.query);
    const where: Prisma.ProductInventoryWhereInput = query.keyword
      ? {
          OR: [
            { productName: { contains: query.keyword, mode: 'insensitive' } },
            { spec: { contains: query.keyword, mode: 'insensitive' } },
          ],
        }
      : {};

    const [total, rows] = await prisma.$transaction([
      prisma.productInventory.count({ where }),
      prisma.productInventory.findMany({
        where,
        orderBy: [{ productName: 'asc' }, { spec: 'asc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);

    return paged(
      reply,
      rows.map((row) => ({
        id: row.id,
        productName: row.productName,
        spec: row.spec,
        quantity: row.quantity,
        version: row.version,
        updatedAt: row.updatedAt.toISOString(),
      })),
      total,
      query.page,
      query.pageSize,
    );
  });

  app.post(
    '/api/v1/inventory/products',
    { preHandler: [authenticate, requireAdmin] },
    async (request, reply) => {
      const auth = authContext(request);
      const body = z
        .object({
          productName: z.string().trim().min(1, '产品名称不能为空').max(100),
          spec: z.string().trim().min(1, '规格不能为空').max(200),
          quantity: z.number().int().min(0).max(10_000_000).default(0),
          reason: z.string().trim().min(2).max(200).optional(),
        })
        .parse(request.body);

      const productKey = productKeyOf(body);

      try {
        const outcome = await runIdempotent({
          actorId: auth.user.id,
          operation: 'inventory.product.create',
          key: request.headers['idempotency-key'],
          body,
          handler: async (tx) => {
          const duplicate = await tx.productInventory.findUnique({ where: { productKey } });
          if (duplicate) {
            throw Errors.conflict('PRODUCT_ALREADY_EXISTS', '该产品（同名同规格）已存在', {
              id: duplicate.id,
            });
          }

          const product = await tx.productInventory.create({
            data: {
              productKey,
              productName: body.productName,
              spec: body.spec,
              quantity: body.quantity,
            },
          });

          if (body.quantity > 0) {
            await tx.inventoryLog.create({
              data: {
                kind: 'PRODUCT',
                productInventoryId: product.id,
                before: 0,
                delta: body.quantity,
                after: body.quantity,
                reason: body.reason ?? '建档初始化',
                operatorId: auth.user.id,
              },
            });
          }

          await writeAudit(tx, {
            requestId: request.id,
            actorId: auth.user.id,
            action: 'inventory.product.create',
            resourceType: 'product_inventory',
            resourceId: product.id,
            after: { productName: product.productName, spec: product.spec, quantity: product.quantity },
          });

            return { status: 201, data: product, resourceId: product.id };
          },
        });

        reply.headers(replayHeaders(outcome.replayed));
        return ok(reply, outcome.data, outcome.replayed ? 200 : 201);
      } catch (error) {
        // 两个请求同时通过上面的存在性检查时，唯一键会拦住后到的一个。
        // 这里把它翻译成同一种业务冲突码，客户端不用区分"先查后建"与"并发撞键"。
        if ((error as { code?: string }).code === 'P2002') {
          const duplicate = await prisma.productInventory.findUnique({ where: { productKey } });
          throw Errors.conflict('PRODUCT_ALREADY_EXISTS', '该产品（同名同规格）已存在', {
            id: duplicate?.id,
          });
        }
        throw error;
      }
    },
  );

  app.post(
    '/api/v1/inventory/products/:id/adjust',
    { preHandler: [authenticate, requireAdmin] },
    async (request, reply) => {
      const auth = authContext(request);
      const { id } = idParam.parse(request.params);
      const body = adjustSchema.parse(request.body);

      const outcome = await runIdempotent({
        actorId: auth.user.id,
        operation: 'inventory.product.adjust',
        key: request.headers['idempotency-key'],
        body: { id, ...body },
        handler: async (tx) => {
          const adjusted = await adjustProductStock(tx, id, {
            delta: body.delta,
            reason: body.reason,
            operatorId: auth.user.id,
          });

          await writeAudit(tx, {
            requestId: request.id,
            actorId: auth.user.id,
            action: 'inventory.product.adjust',
            resourceType: 'product_inventory',
            resourceId: id,
            before: { quantity: adjusted.before },
            after: { quantity: adjusted.after, delta: body.delta, reason: body.reason },
          });

          return { status: 200, data: adjusted, resourceId: id };
        },
      });

      reply.headers(replayHeaders(outcome.replayed));
      return ok(reply, outcome.data);
    },
  );

  // ---------- 出入库流水 ----------
  app.get('/api/v1/inventory/logs', { preHandler: authenticate }, async (request, reply) => {
    const query = logQuerySchema.parse(request.query);
    const where: Prisma.InventoryLogWhereInput = query.kind ? { kind: query.kind } : {};

    const [total, rows] = await prisma.$transaction([
      prisma.inventoryLog.count({ where }),
      prisma.inventoryLog.findMany({
        where,
        include: {
          operator: { select: { displayName: true } },
          part: { select: { code: true, name: true, spec: true } },
          productInventory: { select: { productName: true, spec: true } },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);

    return paged(
      reply,
      rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        target: row.part
          ? `${row.part.code} ${row.part.name} / ${row.part.spec}`
          : row.productInventory
            ? `${row.productInventory.productName} / ${row.productInventory.spec}`
            : '已删除对象',
        before: row.before,
        delta: row.delta,
        after: row.after,
        reason: row.reason,
        operatorName: row.operator.displayName,
        createdAt: row.createdAt.toISOString(),
      })),
      total,
      query.page,
      query.pageSize,
    );
  });
}