import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, authContext, requireAdmin, requireRoles } from '../auth/guards.ts';
import { prisma } from '../db.ts';
import { flowInclude } from '../domain/flow.ts';
import { computeQuantities } from '../domain/flow.ts';
import { toOrderDetail } from '../domain/orders.ts';
import { Errors } from '../errors.ts';
import type { Prisma } from '../generated/prisma/client.ts';
import { ok } from '../http/respond.ts';
import { writeAudit } from '../lib/audit.ts';
import { recordEvent } from '../lib/events.ts';
import { replayHeaders, runIdempotent } from '../lib/idempotency.ts';
import { isDateOnly, parseDateOnly } from '../lib/time.ts';

type Tx = Prisma.TransactionClient;

const idParam = z.object({ id: z.string().uuid('ID 不合法') });

const money = z
  .string()
  .regex(/^(0|[1-9]\d{0,9})(\.\d{1,2})?$/, '金额必须是非负数，最多两位小数');

const positiveInt = z.number().int('数量必须是整数').min(1, '数量必须大于 0').max(10_000_000);

const purchaseSchema = z.object({
  supplierId: z.string().uuid('供应商 ID 不合法'),
  partId: z.string().uuid('配件 ID 不合法'),
  quantity: positiveInt,
  unitPrice: money,
});

const arrivalSchema = z.object({ quantity: positiveInt });

const productionSchema = z.object({
  departmentId: z.string().uuid('部门 ID 不合法'),
  employeeId: z.string().uuid().nullish(),
  processName: z.string().trim().min(1, '工艺名称不能为空').max(50),
  quantity: positiveInt,
  unitPrice: money,
  dueDate: z.string().refine(isDateOnly, '交期必须是 YYYY-MM-DD').optional(),
  unitPriceVisible: z.boolean().default(false),
});

const feedbackSchema = z.object({ quantity: positiveInt });

const qcSchema = z.object({
  inspectedQty: positiveInt,
  qualifiedQty: z.number().int().min(0),
  unqualifiedQty: z.number().int().min(0),
});

const decisionSchema = z.object({ decision: z.enum(['PASS', 'REWORK', 'SCRAP']) });

const packingSchema = z.object({ quantity: positiveInt });
const shipmentSchema = z.object({ quantity: positiveInt });

const emptyBody = z.object({}).passthrough().optional();

async function loadOrder(tx: Tx, orderId: string) {
  const order = await tx.order.findUnique({
    where: { id: orderId },
    include: flowInclude,
  });
  if (!order) throw Errors.notFound('订单不存在', 'ORDER_NOT_FOUND');
  return order;
}

async function finish(tx: Tx, orderId: string, role: Parameters<typeof toOrderDetail>[1], userId: string, departmentId: string | null, status = 200) {
  const fresh = await loadOrder(tx, orderId);
  return { status, data: toOrderDetail(fresh, role, userId, departmentId), resourceId: orderId };
}

function statusError(current: string, expected: string) {
  return Errors.conflict(
    'ORDER_STATUS_CONFLICT',
    `订单当前状态为 ${current}，该操作要求 ${expected}`,
    { current, expected },
  );
}

export async function flowRoutes(app: FastifyInstance): Promise<void> {
  // ---------- 采购 ----------
  app.post('/api/v1/orders/:id/purchase', { preHandler: [authenticate, requireAdmin] }, async (request, reply) => {
    const auth = authContext(request);
    const { id } = idParam.parse(request.params);
    const body = purchaseSchema.parse(request.body);

    const outcome = await runIdempotent({
      actorId: auth.user.id,
      operation: 'purchase.create',
      key: request.headers['idempotency-key'],
      body,
      handler: async (tx) => {
        const order = await loadOrder(tx, id);
        if (order.status !== 'PENDING_PURCHASE') throw statusError(order.status, 'PENDING_PURCHASE');
        if (order.purchaseOrders.length > 0) {
          throw Errors.conflict('PURCHASE_ALREADY_EXISTS', '该订单已存在采购单，M 版本一单一采购单');
        }

        const supplier = await tx.supplier.findUnique({ where: { id: body.supplierId } });
        if (!supplier || !supplier.active) throw Errors.business('供应商不存在或已停用', 'SUPPLIER_NOT_FOUND');
        const part = await tx.part.findUnique({ where: { id: body.partId } });
        if (!part || !part.active) throw Errors.business('配件不存在或已停用', 'PART_NOT_FOUND');

        const purchase = await tx.purchaseOrder.create({
          data: {
            orderId: order.id,
            supplierId: supplier.id,
            supplierName: supplier.name,
            createdById: auth.user.id,
            items: {
              create: [
                {
                  partId: part.id,
                  partName: part.name,
                  partSpec: part.spec,
                  quantity: body.quantity,
                  unitPrice: body.unitPrice,
                },
              ],
            },
          },
        });

        await tx.order.update({ where: { id: order.id }, data: { status: 'PURCHASING' } });

        await recordEvent(tx, {
          orderId: order.id,
          type: 'PURCHASE_CREATED',
          actorId: auth.user.id,
          payload: {
            purchaseOrderId: purchase.id,
            supplierName: supplier.name,
            partName: part.name,
            quantity: body.quantity,
          },
          notify: {
            title: `${order.orderNo} 已创建采购单`,
            body: `向 ${supplier.name} 采购 ${part.name} × ${body.quantity}，等待物流到货。`,
          },
        });

        await writeAudit(tx, {
          requestId: request.id,
          actorId: auth.user.id,
          action: 'purchase.create',
          resourceType: 'purchase',
          resourceId: purchase.id,
          after: { orderId: order.id, supplierId: supplier.id, partId: part.id, quantity: body.quantity },
        });

        return finish(tx, order.id, auth.user.role, auth.user.id, auth.user.departmentId, 201);
      },
    });

    reply.headers(replayHeaders(outcome.replayed));
    return ok(reply, outcome.data, outcome.replayed ? 200 : 201);
  });

  // ---------- 到货 ----------
  app.post('/api/v1/purchases/:id/arrivals', { preHandler: [authenticate, requireRoles('LOGISTICS')] }, async (request, reply) => {
    const auth = authContext(request);
    const { id } = idParam.parse(request.params);
    const body = arrivalSchema.parse(request.body);

    const outcome = await runIdempotent({
      actorId: auth.user.id,
      operation: 'arrival.create',
      key: request.headers['idempotency-key'],
      body,
      handler: async (tx) => {
        const purchase = await tx.purchaseOrder.findUnique({
          where: { id },
          include: { items: { include: { arrivals: true } }, order: true },
        });
        if (!purchase) throw Errors.notFound('采购单不存在', 'PURCHASE_NOT_FOUND');
        if (purchase.order.status !== 'PURCHASING') throw statusError(purchase.order.status, 'PURCHASING');

        const item = purchase.items[0];
        if (!item) throw Errors.business('采购单没有明细', 'PURCHASE_EMPTY');

        const arrived = item.arrivals.reduce((sum, arrival) => sum + arrival.quantity, 0);
        const remaining = item.quantity - arrived;
        if (body.quantity > remaining) {
          throw Errors.business(`本次到货 ${body.quantity} 超过采购剩余 ${remaining}`, 'ARRIVAL_EXCEEDS_REMAINING', {
            remaining,
          });
        }

        const arrival = await tx.arrivalRecord.create({
          data: {
            purchaseItemId: item.id,
            quantity: body.quantity,
            operatorId: auth.user.id,
          },
        });

        await recordEvent(tx, {
          orderId: purchase.orderId,
          type: 'ARRIVAL_RECORDED',
          actorId: auth.user.id,
          payload: { arrivalId: arrival.id, quantity: body.quantity, partName: item.partName },
          notify: {
            title: `${purchase.order.orderNo} 到货 ${body.quantity} 件`,
            body: `${item.partName} 本次到货 ${body.quantity}，累计 ${arrived + body.quantity} / ${item.quantity}。`,
          },
        });

        await writeAudit(tx, {
          requestId: request.id,
          actorId: auth.user.id,
          action: 'arrival.create',
          resourceType: 'arrival',
          resourceId: arrival.id,
          after: { purchaseItemId: item.id, quantity: body.quantity, cumulative: arrived + body.quantity },
        });

        return finish(tx, purchase.orderId, auth.user.role, auth.user.id, auth.user.departmentId, 201);
      },
    });

    reply.headers(replayHeaders(outcome.replayed));
    return ok(reply, outcome.data, outcome.replayed ? 200 : 201);
  });

  // ---------- 生产下发 ----------
  app.post('/api/v1/orders/:id/productions', { preHandler: [authenticate, requireAdmin] }, async (request, reply) => {
    const auth = authContext(request);
    const { id } = idParam.parse(request.params);
    const body = productionSchema.parse(request.body);

    const outcome = await runIdempotent({
      actorId: auth.user.id,
      operation: 'production.dispatch',
      key: request.headers['idempotency-key'],
      body,
      handler: async (tx) => {
        const order = await loadOrder(tx, id);
        if (order.status !== 'PURCHASING') throw statusError(order.status, 'PURCHASING');
        if (order.productions.length > 0) {
          throw Errors.conflict('PRODUCTION_ALREADY_DISPATCHED', '该订单已下发过生产任务');
        }

        const quantities = computeQuantities(order);
        if (quantities.purchaseQty === 0) throw Errors.business('尚未创建采购单', 'PURCHASE_REQUIRED');
        if (quantities.arrivedQty < quantities.purchaseQty) {
          throw Errors.business(
            `采购尚未全部到货（${quantities.arrivedQty} / ${quantities.purchaseQty}），不能下发生产`,
            'ARRIVAL_INCOMPLETE',
            { arrived: quantities.arrivedQty, purchase: quantities.purchaseQty },
          );
        }

        const department = await tx.department.findUnique({ where: { id: body.departmentId } });
        if (!department || !department.active) throw Errors.business('部门不存在或已停用', 'DEPARTMENT_NOT_FOUND');
        if (department.category !== 'PRODUCTION') {
          throw Errors.business('只能下发给生产部门', 'DEPARTMENT_CATEGORY_MISMATCH');
        }

        if (body.employeeId) {
          const employee = await tx.employee.findUnique({ where: { id: body.employeeId } });
          if (!employee || !employee.active) throw Errors.business('员工不存在或已停用', 'EMPLOYEE_NOT_FOUND');
          if (employee.departmentId !== department.id) {
            throw Errors.business('员工不属于目标部门', 'EMPLOYEE_DEPARTMENT_MISMATCH');
          }
        }

        const item = order.items[0];
        if (!item) throw Errors.business('订单没有产品明细', 'ORDER_ITEM_MISSING');

        const production = await tx.productionOrder.create({
          data: {
            orderId: order.id,
            orderItemId: item.id,
            departmentId: department.id,
            employeeId: body.employeeId ?? null,
            processName: body.processName,
            quantity: body.quantity,
            unitPrice: body.unitPrice,
            dueDate: body.dueDate ? parseDateOnly(body.dueDate) : null,
            unitPriceVisible: body.unitPriceVisible,
            createdById: auth.user.id,
          },
        });

        await tx.order.update({ where: { id: order.id }, data: { status: 'IN_PRODUCTION' } });

        await recordEvent(tx, {
          orderId: order.id,
          type: 'PRODUCTION_DISPATCHED',
          actorId: auth.user.id,
          payload: {
            productionOrderId: production.id,
            departmentName: department.name,
            processName: body.processName,
            quantity: body.quantity,
          },
          notify: {
            title: `${order.orderNo} 已下发生产`,
            body: `${department.name} · ${body.processName} × ${body.quantity}，等待现场反馈。`,
          },
        });

        await writeAudit(tx, {
          requestId: request.id,
          actorId: auth.user.id,
          action: 'production.dispatch',
          resourceType: 'production',
          resourceId: production.id,
          after: { orderId: order.id, departmentId: department.id, quantity: body.quantity },
        });

        return finish(tx, order.id, auth.user.role, auth.user.id, auth.user.departmentId, 201);
      },
    });

    reply.headers(replayHeaders(outcome.replayed));
    return ok(reply, outcome.data, outcome.replayed ? 200 : 201);
  });

  // ---------- 生产反馈 ----------
  app.post('/api/v1/productions/:id/feedback', { preHandler: [authenticate, requireRoles('PRODUCTION')] }, async (request, reply) => {
    const auth = authContext(request);
    const { id } = idParam.parse(request.params);
    const body = feedbackSchema.parse(request.body);

    const outcome = await runIdempotent({
      actorId: auth.user.id,
      operation: 'production.feedback',
      key: request.headers['idempotency-key'],
      body,
      handler: async (tx) => {
        const production = await tx.productionOrder.findUnique({
          where: { id },
          include: { feedbacks: true, order: true },
        });
        if (!production) throw Errors.notFound('生产任务不存在', 'PRODUCTION_NOT_FOUND');
        if (production.order.status !== 'IN_PRODUCTION') {
          throw statusError(production.order.status, 'IN_PRODUCTION');
        }
        if (auth.user.departmentId === null || production.departmentId !== auth.user.departmentId) {
          throw Errors.forbidden('该生产任务不属于你的部门');
        }
        if (production.feedbacks.length > 0) {
          throw Errors.conflict('FEEDBACK_ALREADY_RECORDED', '该生产任务已反馈，M 版本一次任务一次反馈');
        }
        if (body.quantity > production.quantity) {
          throw Errors.business(
            `反馈数量 ${body.quantity} 超过任务数量 ${production.quantity}`,
            'FEEDBACK_EXCEEDS_TASK',
            { taskQuantity: production.quantity },
          );
        }

        const feedback = await tx.productionFeedback.create({
          data: { productionOrderId: production.id, quantity: body.quantity, operatorId: auth.user.id },
        });

        await recordEvent(tx, {
          orderId: production.orderId,
          type: 'PRODUCTION_FEEDBACK',
          actorId: auth.user.id,
          payload: {
            productionOrderId: production.id,
            feedbackId: feedback.id,
            quantity: body.quantity,
            processName: production.processName,
          },
          notify: {
            title: `${production.order.orderNo} 生产反馈 ${body.quantity} 件`,
            body: `${production.processName} 完成 ${body.quantity}，等待管理员下发质检。`,
          },
        });

        await writeAudit(tx, {
          requestId: request.id,
          actorId: auth.user.id,
          action: 'production.feedback',
          resourceType: 'production',
          resourceId: production.id,
          after: { feedbackId: feedback.id, quantity: body.quantity },
        });

        return finish(tx, production.orderId, auth.user.role, auth.user.id, auth.user.departmentId, 201);
      },
    });

    reply.headers(replayHeaders(outcome.replayed));
    return ok(reply, outcome.data, outcome.replayed ? 200 : 201);
  });

  // ---------- 质检下发 ----------
  app.post('/api/v1/orders/:id/qc-dispatch', { preHandler: [authenticate, requireAdmin] }, async (request, reply) => {
    const auth = authContext(request);
    const { id } = idParam.parse(request.params);
    emptyBody.parse(request.body ?? {});

    const outcome = await runIdempotent({
      actorId: auth.user.id,
      operation: 'qc.dispatch',
      key: request.headers['idempotency-key'],
      body: { orderId: id },
      handler: async (tx) => {
        const order = await loadOrder(tx, id);
        if (order.status !== 'IN_PRODUCTION') throw statusError(order.status, 'IN_PRODUCTION');

        const production = order.productions.at(-1);
        if (!production) throw Errors.business('还没有生产任务', 'PRODUCTION_REQUIRED');
        if (production.qcRecords.length > 0) {
          throw Errors.conflict('QC_ALREADY_DISPATCHED', '该生产任务已下发质检');
        }
        const produced = production.feedbacks.reduce((sum, f) => sum + f.quantity, 0);
        if (produced <= 0) throw Errors.business('生产尚未反馈完成数量，不能下发质检', 'NO_PRODUCED_QTY');

        await tx.order.update({ where: { id: order.id }, data: { status: 'PENDING_QC' } });

        await recordEvent(tx, {
          orderId: order.id,
          type: 'QC_DISPATCHED',
          actorId: auth.user.id,
          payload: { productionOrderId: production.id, produced },
          notify: {
            title: `${order.orderNo} 已下发质检`,
            body: `待检数量 ${produced}，等待品控录入检验结果。`,
          },
        });

        await writeAudit(tx, {
          requestId: request.id,
          actorId: auth.user.id,
          action: 'qc.dispatch',
          resourceType: 'order',
          resourceId: order.id,
          after: { productionOrderId: production.id, produced },
        });

        return finish(tx, order.id, auth.user.role, auth.user.id, auth.user.departmentId);
      },
    });

    reply.headers(replayHeaders(outcome.replayed));
    return ok(reply, outcome.data, outcome.replayed ? 200 : 201);
  });

  // ---------- 质检录入 ----------
  app.post('/api/v1/productions/:id/qc-records', { preHandler: [authenticate, requireRoles('QC')] }, async (request, reply) => {
    const auth = authContext(request);
    const { id } = idParam.parse(request.params);
    const body = qcSchema.parse(request.body);

    const outcome = await runIdempotent({
      actorId: auth.user.id,
      operation: 'qc.record',
      key: request.headers['idempotency-key'],
      body,
      handler: async (tx) => {
        const production = await tx.productionOrder.findUnique({
          where: { id },
          include: { feedbacks: true, qcRecords: true, order: true },
        });
        if (!production) throw Errors.notFound('生产任务不存在', 'PRODUCTION_NOT_FOUND');
        if (production.order.status !== 'PENDING_QC') throw statusError(production.order.status, 'PENDING_QC');
        if (production.qcRecords.length > 0) {
          throw Errors.conflict('QC_ALREADY_RECORDED', '该生产任务已录入质检结果');
        }

        if (body.qualifiedQty + body.unqualifiedQty !== body.inspectedQty) {
          throw Errors.business('合格量 + 不合格量必须等于检验量', 'QC_QTY_MISMATCH', {
            inspectedQty: body.inspectedQty,
            qualifiedQty: body.qualifiedQty,
            unqualifiedQty: body.unqualifiedQty,
          });
        }
        if (body.unqualifiedQty > 0) {
          throw Errors.business('M 版本仅支持全合格质检，不合格量必须为 0', 'QC_PARTIAL_NOT_SUPPORTED');
        }

        const produced = production.feedbacks.reduce((sum, f) => sum + f.quantity, 0);
        if (body.inspectedQty > produced) {
          throw Errors.business(`检验量 ${body.inspectedQty} 超过已生产数量 ${produced}`, 'QC_EXCEEDS_PRODUCED', {
            produced,
          });
        }

        const record = await tx.qCRecord.create({
          data: {
            productionOrderId: production.id,
            inspectedQty: body.inspectedQty,
            qualifiedQty: body.qualifiedQty,
            unqualifiedQty: body.unqualifiedQty,
            operatorId: auth.user.id,
          },
        });

        await recordEvent(tx, {
          orderId: production.orderId,
          type: 'QC_RECORDED',
          actorId: auth.user.id,
          payload: {
            qcRecordId: record.id,
            inspectedQty: body.inspectedQty,
            qualifiedQty: body.qualifiedQty,
            unqualifiedQty: body.unqualifiedQty,
          },
          notify: {
            title: `${production.order.orderNo} 质检已录入`,
            body: `检验 ${body.inspectedQty}，合格 ${body.qualifiedQty}，等待管理员放行决策。`,
          },
        });

        await writeAudit(tx, {
          requestId: request.id,
          actorId: auth.user.id,
          action: 'qc.record',
          resourceType: 'qc',
          resourceId: record.id,
          after: { inspectedQty: body.inspectedQty, qualifiedQty: body.qualifiedQty },
        });

        return finish(tx, production.orderId, auth.user.role, auth.user.id, auth.user.departmentId, 201);
      },
    });

    reply.headers(replayHeaders(outcome.replayed));
    return ok(reply, outcome.data, outcome.replayed ? 200 : 201);
  });

  // ---------- 质检决策 ----------
  app.post('/api/v1/qc-records/:id/decision', { preHandler: [authenticate, requireAdmin] }, async (request, reply) => {
    const auth = authContext(request);
    const { id } = idParam.parse(request.params);
    const body = decisionSchema.parse(request.body);

    const outcome = await runIdempotent({
      actorId: auth.user.id,
      operation: 'qc.decide',
      key: request.headers['idempotency-key'],
      body,
      handler: async (tx) => {
        const record = await tx.qCRecord.findUnique({
          where: { id },
          include: { decision: true, productionOrder: { include: { order: true } } },
        });
        if (!record) throw Errors.notFound('质检记录不存在', 'QC_RECORD_NOT_FOUND');
        const order = record.productionOrder.order;
        if (order.status !== 'PENDING_QC') throw statusError(order.status, 'PENDING_QC');
        if (record.decision) throw Errors.conflict('QC_ALREADY_DECIDED', '该质检记录已有决策');
        if (body.decision !== 'PASS') {
          throw Errors.business('M 版本仅支持全合格 PASS，返工与报废为 F 未实现', 'QC_DECISION_NOT_SUPPORTED');
        }

        const decision = await tx.qCDecision.create({
          data: {
            qcRecordId: record.id,
            decision: 'PASS',
            releasedQty: record.qualifiedQty,
            decidedById: auth.user.id,
          },
        });

        await tx.order.update({ where: { id: order.id }, data: { status: 'QC_DONE' } });

        await recordEvent(tx, {
          orderId: order.id,
          type: 'QC_PASSED',
          actorId: auth.user.id,
          payload: {
            qcRecordId: record.id,
            decisionId: decision.id,
            releasedQty: record.qualifiedQty,
          },
          notify: {
            title: `${order.orderNo} 质检放行 ${record.qualifiedQty} 件`,
            body: '等待管理员下发包装。',
          },
        });

        await writeAudit(tx, {
          requestId: request.id,
          actorId: auth.user.id,
          action: 'qc.decide',
          resourceType: 'qc_decision',
          resourceId: decision.id,
          after: { qcRecordId: record.id, decision: 'PASS', releasedQty: record.qualifiedQty },
        });

        return finish(tx, order.id, auth.user.role, auth.user.id, auth.user.departmentId, 201);
      },
    });

    reply.headers(replayHeaders(outcome.replayed));
    return ok(reply, outcome.data, outcome.replayed ? 200 : 201);
  });

  // ---------- 包装下发 ----------
  app.post('/api/v1/orders/:id/packing-dispatch', { preHandler: [authenticate, requireAdmin] }, async (request, reply) => {
    const auth = authContext(request);
    const { id } = idParam.parse(request.params);
    emptyBody.parse(request.body ?? {});

    const outcome = await runIdempotent({
      actorId: auth.user.id,
      operation: 'packing.dispatch',
      key: request.headers['idempotency-key'],
      body: { orderId: id },
      handler: async (tx) => {
        const order = await loadOrder(tx, id);
        if (order.status !== 'QC_DONE') throw statusError(order.status, 'QC_DONE');
        const quantities = computeQuantities(order);
        if (quantities.releasedQty <= 0) {
          throw Errors.business('没有可包装的放行合格量', 'NO_RELEASED_QTY');
        }

        await tx.order.update({ where: { id: order.id }, data: { status: 'PACKING' } });

        await recordEvent(tx, {
          orderId: order.id,
          type: 'PACKING_DISPATCHED',
          actorId: auth.user.id,
          payload: { releasedQty: quantities.releasedQty },
          notify: {
            title: `${order.orderNo} 已下发包装`,
            body: `可包装 ${quantities.releasedQty} 件，等待包装反馈。`,
          },
        });

        await writeAudit(tx, {
          requestId: request.id,
          actorId: auth.user.id,
          action: 'packing.dispatch',
          resourceType: 'order',
          resourceId: order.id,
          after: { releasedQty: quantities.releasedQty },
        });

        return finish(tx, order.id, auth.user.role, auth.user.id, auth.user.departmentId);
      },
    });

    reply.headers(replayHeaders(outcome.replayed));
    return ok(reply, outcome.data, outcome.replayed ? 200 : 201);
  });

  // ---------- 包装登记 ----------
  app.post('/api/v1/orders/:id/packing-records', { preHandler: [authenticate, requireRoles('PACKING')] }, async (request, reply) => {
    const auth = authContext(request);
    const { id } = idParam.parse(request.params);
    const body = packingSchema.parse(request.body);

    const outcome = await runIdempotent({
      actorId: auth.user.id,
      operation: 'packing.record',
      key: request.headers['idempotency-key'],
      body,
      handler: async (tx) => {
        const order = await loadOrder(tx, id);
        if (order.status !== 'PACKING') throw statusError(order.status, 'PACKING');
        const quantities = computeQuantities(order);
        if (body.quantity > quantities.packableRemaining) {
          throw Errors.business(
            `包装 ${body.quantity} 超过可包装剩余 ${quantities.packableRemaining}`,
            'PACKING_EXCEEDS_REMAINING',
            { packableRemaining: quantities.packableRemaining },
          );
        }

        const item = order.items[0];
        if (!item) throw Errors.business('订单没有产品明细', 'ORDER_ITEM_MISSING');

        const record = await tx.packingRecord.create({
          data: {
            orderId: order.id,
            orderItemId: item.id,
            quantity: body.quantity,
            operatorId: auth.user.id,
          },
        });

        await recordEvent(tx, {
          orderId: order.id,
          type: 'PACKING_RECORDED',
          actorId: auth.user.id,
          payload: { packingRecordId: record.id, quantity: body.quantity },
          notify: {
            title: `${order.orderNo} 已包装 ${body.quantity} 件`,
            body: `累计包装 ${quantities.packedQty + body.quantity} / ${quantities.releasedQty}，等待管理员触发发货。`,
          },
        });

        await writeAudit(tx, {
          requestId: request.id,
          actorId: auth.user.id,
          action: 'packing.record',
          resourceType: 'packing',
          resourceId: record.id,
          after: { quantity: body.quantity, cumulative: quantities.packedQty + body.quantity },
        });

        return finish(tx, order.id, auth.user.role, auth.user.id, auth.user.departmentId, 201);
      },
    });

    reply.headers(replayHeaders(outcome.replayed));
    return ok(reply, outcome.data, outcome.replayed ? 200 : 201);
  });

  // ---------- 触发发货 ----------
  app.post('/api/v1/orders/:id/shipping-trigger', { preHandler: [authenticate, requireAdmin] }, async (request, reply) => {
    const auth = authContext(request);
    const { id } = idParam.parse(request.params);
    emptyBody.parse(request.body ?? {});

    const outcome = await runIdempotent({
      actorId: auth.user.id,
      operation: 'shipping.trigger',
      key: request.headers['idempotency-key'],
      body: { orderId: id },
      handler: async (tx) => {
        const order = await loadOrder(tx, id);
        if (order.status !== 'PACKING') throw statusError(order.status, 'PACKING');
        const quantities = computeQuantities(order);
        if (quantities.packedQty <= 0) {
          throw Errors.business('尚未包装，不能触发发货', 'NO_PACKED_QTY');
        }

        await tx.order.update({ where: { id: order.id }, data: { status: 'SHIPPING' } });

        await recordEvent(tx, {
          orderId: order.id,
          type: 'SHIPPING_TRIGGERED',
          actorId: auth.user.id,
          payload: { packedQty: quantities.packedQty },
          notify: {
            title: `${order.orderNo} 已触发发货`,
            body: `可发货 ${quantities.packedQty} 件，等待物流登记发货。`,
          },
        });

        await writeAudit(tx, {
          requestId: request.id,
          actorId: auth.user.id,
          action: 'shipping.trigger',
          resourceType: 'order',
          resourceId: order.id,
          after: { packedQty: quantities.packedQty },
        });

        return finish(tx, order.id, auth.user.role, auth.user.id, auth.user.departmentId);
      },
    });

    reply.headers(replayHeaders(outcome.replayed));
    return ok(reply, outcome.data, outcome.replayed ? 200 : 201);
  });

  // ---------- 发货登记 ----------
  app.post('/api/v1/orders/:id/shipment-records', { preHandler: [authenticate, requireRoles('LOGISTICS')] }, async (request, reply) => {
    const auth = authContext(request);
    const { id } = idParam.parse(request.params);
    const body = shipmentSchema.parse(request.body);

    const outcome = await runIdempotent({
      actorId: auth.user.id,
      operation: 'shipment.record',
      key: request.headers['idempotency-key'],
      body,
      handler: async (tx) => {
        const order = await loadOrder(tx, id);
        if (order.status !== 'SHIPPING') throw statusError(order.status, 'SHIPPING');
        const quantities = computeQuantities(order);
        const limit = Math.min(quantities.shippableRemaining, quantities.dueRemaining);
        if (body.quantity > limit) {
          throw Errors.business(`发货 ${body.quantity} 超过可发货上限 ${limit}`, 'SHIPMENT_EXCEEDS_LIMIT', {
            shippableRemaining: quantities.shippableRemaining,
            dueRemaining: quantities.dueRemaining,
            limit,
          });
        }

        const item = order.items[0];
        if (!item) throw Errors.business('订单没有产品明细', 'ORDER_ITEM_MISSING');

        const record = await tx.shipmentRecord.create({
          data: {
            orderId: order.id,
            orderItemId: item.id,
            quantity: body.quantity,
            operatorId: auth.user.id,
          },
        });

        const shippedTotal = quantities.shippedQty + body.quantity;
        const completed = shippedTotal >= quantities.orderQty;
        if (completed) {
          await tx.order.update({
            where: { id: order.id },
            data: { status: 'COMPLETED', completedAt: new Date() },
          });
        }

        await recordEvent(tx, {
          orderId: order.id,
          type: 'SHIPMENT_RECORDED',
          actorId: auth.user.id,
          payload: { shipmentId: record.id, quantity: body.quantity, shippedTotal },
          notify: {
            title: completed
              ? `${order.orderNo} 已发货完成`
              : `${order.orderNo} 已发货 ${body.quantity} 件`,
            body: completed
              ? `累计发货 ${shippedTotal} / ${quantities.orderQty}，订单完成。`
              : `累计发货 ${shippedTotal} / ${quantities.orderQty}。`,
          },
        });

        await writeAudit(tx, {
          requestId: request.id,
          actorId: auth.user.id,
          action: 'shipment.record',
          resourceType: 'shipment',
          resourceId: record.id,
          after: { quantity: body.quantity, shippedTotal, completed },
        });

        return finish(tx, order.id, auth.user.role, auth.user.id, auth.user.departmentId, 201);
      },
    });

    reply.headers(replayHeaders(outcome.replayed));
    return ok(reply, outcome.data, outcome.replayed ? 200 : 201);
  });
}