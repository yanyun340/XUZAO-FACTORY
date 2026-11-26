import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticate, authContext, requireAdmin } from '../auth/guards.ts';
import { computeQuantities, isActive } from '../domain/flow.ts';
import { toOrderDetail } from '../domain/orders.ts';
import { clearsCompletedAt, deriveRepairedStatus } from '../domain/status.ts';
import { Errors } from '../errors.ts';
import type { Prisma } from '../generated/prisma/client.ts';
import { ok } from '../http/respond.ts';
import type { NotificationCategory } from '../generated/prisma/enums.ts';
import { writeAudit } from '../lib/audit.ts';
import { isWithinUndoWindow, now, undoableUntil } from '../lib/clock.ts';
import { recordEvent } from '../lib/events.ts';
import { replayHeaders, runIdempotent } from '../lib/idempotency.ts';
import { finish, loadOrder } from './flow.ts';

type Tx = Prisma.TransactionClient;

const idParam = z.object({ id: z.string().uuid('ID 不合法') });

/** R12F：修正必须写原因，2–200 字，与异常处置说明同一口径。 */
const correctSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(2, '修正原因至少 2 个字')
    .max(200, '修正原因最多 200 个字'),
});

const emptyBody = z.object({}).passthrough().optional();

export type RecordKind = 'arrival' | 'feedback' | 'qc' | 'packing' | 'shipment';

interface LoadedRecord {
  id: string;
  orderId: string;
  operatorId: string;
  createdAt: Date;
  quantity: number;
  voidedAt: Date | null;
  /** qc 专用：用于作废决策与判断子记录。 */
  productionOrderId?: string;
  /** arrival 专用：查电镀依赖用。 */
  purchaseItemId?: string;
}

interface RecordAdapter {
  kind: RecordKind;
  /** 路由前缀，如 `arrivals` → `/api/v1/arrivals/:id/undo`。 */
  path: string;
  load(tx: Tx, id: string): Promise<LoadedRecord>;
  /** 下游依赖校验；不通过直接抛错。 */
  guardVoid(tx: Tx, record: LoadedRecord): Promise<void>;
  /** 只写作废标记，其它联动（如决策）也在这里、同一事务内完成。 */
  voidRecord(tx: Tx, record: LoadedRecord, input: { actorId: string; reason: string }): Promise<void>;
  eventType: { undo: string; correct: string };
  auditAction: { undo: string; correct: string };
  auditResourceType: string;
  category: NotificationCategory;
  /** 事件与审计里显示的记录类型中文名。 */
  label: string;
}

function notFound(kind: RecordKind, label: string) {
  return Errors.notFound(`${label}记录不存在`, `${kind.toUpperCase()}_NOT_FOUND`);
}

/* ---------- 到货 ---------- */
const arrivalAdapter: RecordAdapter = {
  kind: 'arrival',
  path: 'arrivals',
  label: '到货',
  category: 'ORDER',
  eventType: { undo: 'ARRIVAL_UNDONE', correct: 'ARRIVAL_CORRECTED' },
  auditAction: { undo: 'arrival.undo', correct: 'arrival.correct' },
  auditResourceType: 'arrival',

  async load(tx, id) {
    const row = await tx.arrivalRecord.findUnique({
      where: { id },
      include: { purchaseItem: { include: { purchaseOrder: true } } },
    });
    if (!row) throw notFound('arrival', '到货');
    return {
      id: row.id,
      orderId: row.purchaseItem.purchaseOrder.orderId,
      operatorId: row.operatorId,
      createdAt: row.createdAt,
      quantity: row.quantity,
      voidedAt: row.voidedAt,
      purchaseItemId: row.purchaseItemId,
    };
  },

  async guardVoid(tx, record) {
    // A17：有生产依赖的到货不能撤销——产量建立在到货量之上。
    const production = await tx.productionOrder.findFirst({
      where: { orderId: record.orderId },
      select: { id: true },
    });
    if (production) {
      throw Errors.conflict(
        'UNDO_HAS_PRODUCTION',
        '该订单已下发生产任务，到货记录不能再撤销',
      );
    }
    // A17：电镀单依赖这批到货量。PENDING 也算——建单时是按到货量校验的，
    // 撤掉到货后再发送/收货就会出现「没收货却有电镀量」。
    const plating = await tx.platingOrder.findFirst({
      where: { purchaseItemId: record.purchaseItemId },
      select: { id: true, status: true },
    });
    if (plating) {
      throw Errors.conflict(
        'UNDO_HAS_PLATING',
        plating.status === 'PENDING'
          ? '该采购项已建电镀单，请先按依赖逆序删除电镀单'
          : '该采购项的电镀单已发出或已收货，到货记录不能再撤销',
      );
    }
  },

  async voidRecord(tx, record, input) {
    await tx.arrivalRecord.update({
      where: { id: record.id },
      data: { voidedAt: now(), voidedById: input.actorId, voidReason: input.reason },
    });
  },
};

/* ---------- 生产反馈 ---------- */
const feedbackAdapter: RecordAdapter = {
  kind: 'feedback',
  path: 'feedbacks',
  label: '生产反馈',
  category: 'PRODUCTION',
  eventType: {
    undo: 'PRODUCTION_FEEDBACK_UNDONE',
    correct: 'PRODUCTION_FEEDBACK_CORRECTED',
  },
  auditAction: {
    undo: 'production.feedback.undo',
    correct: 'production.feedback.correct',
  },
  // 撤销/修正作用在「反馈记录」上，resourceId 是记录 id；
  // 既有 production.feedback 审计记的是生产任务 id，所以这里单独用 production_feedback。
  auditResourceType: 'production_feedback',

  async load(tx, id) {
    const row = await tx.productionFeedback.findUnique({
      where: { id },
      include: { productionOrder: true },
    });
    if (!row) throw notFound('feedback', '生产反馈');
    return {
      id: row.id,
      orderId: row.productionOrder.orderId,
      productionOrderId: row.productionOrderId,
      operatorId: row.operatorId,
      createdAt: row.createdAt,
      quantity: row.quantity,
      voidedAt: row.voidedAt,
    };
  },

  async guardVoid(tx, record) {
    // 已有质检结果，说明产量已被下游使用。
    const qc = await tx.qCRecord.findFirst({
      where: { productionOrderId: record.productionOrderId, voidedAt: null },
      select: { id: true },
    });
    if (qc) {
      throw Errors.conflict('UNDO_HAS_QC', '该生产任务已录入质检结果，反馈记录不能再撤销');
    }
    const waiting = await tx.tabletException.findFirst({
      where: { productionOrderId: record.productionOrderId, status: 'WAITING_QC' },
      select: { id: true },
    });
    if (waiting) {
      throw Errors.conflict(
        'UNDO_EXCEPTION_REVIEWING',
        '该生产任务有待复核的异常，反馈记录不能再撤销',
      );
    }
  },

  async voidRecord(tx, record, input) {
    await tx.productionFeedback.update({
      where: { id: record.id },
      data: { voidedAt: now(), voidedById: input.actorId, voidReason: input.reason },
    });
  },
};

/* ---------- 质检记录（连同决策） ---------- */
const qcAdapter: RecordAdapter = {
  kind: 'qc',
  path: 'qc-records',
  label: '质检',
  category: 'QC',
  eventType: { undo: 'QC_RECORD_UNDONE', correct: 'QC_RECORD_CORRECTED' },
  auditAction: { undo: 'qc.undo', correct: 'qc.correct' },
  auditResourceType: 'qc',

  async load(tx, id) {
    const row = await tx.qCRecord.findUnique({
      where: { id },
      include: { productionOrder: true },
    });
    if (!row) throw notFound('qc', '质检');
    return {
      id: row.id,
      orderId: row.productionOrder.orderId,
      productionOrderId: row.productionOrderId,
      operatorId: row.operatorId,
      createdAt: row.createdAt,
      quantity: row.inspectedQty,
      voidedAt: row.voidedAt,
    };
  },

  async guardVoid(tx, record) {
    // 返工复检建立在父记录之上，先撤子记录。
    const child = await tx.qCRecord.findFirst({
      where: { parentQcRecordId: record.id, voidedAt: null },
      select: { id: true },
    });
    if (child) {
      throw Errors.conflict(
        'UNDO_HAS_CHILD_QC',
        '该质检记录已有复检记录，请按依赖逆序先撤销复检',
      );
    }

    // A17：已包装的放行量不能撤回。
    // 注意「已下发包装」也算——PACKING 只允许 packedQty>0 才能触发发货，
    // 此时撤掉 QC 会让 packedQty 与 packableRemaining 同时为 0，订单再也走不动。
    const order = await loadOrder(tx, record.orderId);
    const quantities = computeQuantities(order);
    const packingStarted = ['PACKING', 'SHIPPING', 'COMPLETED'].includes(order.status);
    if (quantities.packedQty > 0 || packingStarted) {
      throw Errors.conflict(
        'UNDO_HAS_PACKING',
        quantities.packedQty > 0
          ? `订单已包装 ${quantities.packedQty} 件，质检记录不能再撤销`
          : '订单已下发包装，请先按依赖逆序撤销包装记录',
      );
    }

    // 异常凭证：等待复核或已解决的异常都依赖这条质检结果。
    const exception = await tx.tabletException.findFirst({
      where: { qcRecordId: record.id, status: { in: ['WAITING_QC', 'RESOLVED'] } },
      select: { id: true, status: true },
    });
    if (exception) {
      throw Errors.conflict(
        'UNDO_EXCEPTION_REFERENCED',
        exception.status === 'RESOLVED'
          ? '该质检记录是已解决异常的凭证，不能再撤销'
          : '该质检记录被待复核异常引用，请先解决异常',
      );
    }

    // 未处置异常只是记录了「这条不合格」，撤销后把指针清掉即可，不阻塞。
    // CLOSED 是已闭环的历史，保留引用不丢证据（行本身还在，审计可查）。
    await tx.tabletException.updateMany({
      where: { qcRecordId: record.id, status: { in: ['OPEN', 'IN_PROGRESS'] } },
      data: { qcRecordId: null },
    });
  },

  async voidRecord(tx, record, input) {
    const at = now();
    await tx.qCRecord.update({
      where: { id: record.id },
      data: { voidedAt: at, voidedById: input.actorId, voidReason: input.reason },
    });
    // R09F：一条质检记录只有一条决策，撤销必须同事务连决策一起作废。
    await tx.qCDecision.updateMany({
      where: { qcRecordId: record.id, voidedAt: null },
      data: { voidedAt: at, voidReason: input.reason },
    });
  },
};

/* ---------- 包装 ---------- */
const packingAdapter: RecordAdapter = {
  kind: 'packing',
  path: 'packing-records',
  label: '包装',
  category: 'PACKING',
  eventType: { undo: 'PACKING_UNDONE', correct: 'PACKING_CORRECTED' },
  auditAction: { undo: 'packing.undo', correct: 'packing.correct' },
  auditResourceType: 'packing',

  async load(tx, id) {
    const row = await tx.packingRecord.findUnique({ where: { id } });
    if (!row) throw notFound('packing', '包装');
    return {
      id: row.id,
      orderId: row.orderId,
      operatorId: row.operatorId,
      createdAt: row.createdAt,
      quantity: row.quantity,
      voidedAt: row.voidedAt,
    };
  },

  async guardVoid(tx, record) {
    // A17：已发货的包装不能撤销。
    // 「已触发发货」同样禁止：撤掉包装后 packedQty=0，record-shipment 与
    // trigger-shipping 都不再可用，订单会卡在 SHIPPING。
    const order = await loadOrder(tx, record.orderId);
    const quantities = computeQuantities(order);
    const shippingStarted = ['SHIPPING', 'COMPLETED'].includes(order.status);
    if (quantities.shippedQty > 0 || shippingStarted) {
      throw Errors.conflict(
        'UNDO_HAS_SHIPMENT',
        quantities.shippedQty > 0
          ? `订单已发货 ${quantities.shippedQty} 件，包装记录不能再撤销`
          : '订单已触发发货，请先按依赖逆序撤销发货登记',
      );
    }
  },

  async voidRecord(tx, record, input) {
    await tx.packingRecord.update({
      where: { id: record.id },
      data: { voidedAt: now(), voidedById: input.actorId, voidReason: input.reason },
    });
  },
};

/* ---------- 发货 ---------- */
const shipmentAdapter: RecordAdapter = {
  kind: 'shipment',
  path: 'shipment-records',
  label: '发货',
  category: 'SHIPPING',
  eventType: { undo: 'SHIPMENT_UNDONE', correct: 'SHIPMENT_CORRECTED' },
  auditAction: { undo: 'shipment.undo', correct: 'shipment.correct' },
  auditResourceType: 'shipment',

  async load(tx, id) {
    const row = await tx.shipmentRecord.findUnique({ where: { id } });
    if (!row) throw notFound('shipment', '发货');
    return {
      id: row.id,
      orderId: row.orderId,
      operatorId: row.operatorId,
      createdAt: row.createdAt,
      quantity: row.quantity,
      voidedAt: row.voidedAt,
    };
  },

  async guardVoid() {
    // 发货是链尾，没有下游依赖；剩下的只有状态回退（见 recomputeStatus）。
  },

  async voidRecord(tx, record, input) {
    await tx.shipmentRecord.update({
      where: { id: record.id },
      data: { voidedAt: now(), voidedById: input.actorId, voidReason: input.reason },
    });
  },
};

const RECORD_ADAPTERS: RecordAdapter[] = [
  arrivalAdapter,
  feedbackAdapter,
  qcAdapter,
  packingAdapter,
  shipmentAdapter,
];

/**
 * R12F：作废后重算订单状态。
 * 只允许三条反向边（见 domain/status.ts），不做通用投影。
 */
async function recomputeStatus(tx: Tx, orderId: string): Promise<{ before: string; after: string }> {
  const order = await loadOrder(tx, orderId);
  const quantities = computeQuantities(order);

  const activeQcRecord = order.productions.some((production) =>
    production.qcRecords.some(isActive),
  );
  const waitingException = await tx.tabletException.findFirst({
    where: {
      status: 'WAITING_QC',
      productionOrderId: { in: order.productions.map((production) => production.id) },
    },
    select: { id: true },
  });

  const next = deriveRepairedStatus(order.status, quantities, {
    hasActiveQcRecord: activeQcRecord,
    hasWaitingQcException: Boolean(waitingException),
  });
  if (next === order.status) return { before: order.status, after: order.status };

  await tx.order.update({
    where: { id: orderId },
    data: clearsCompletedAt(order.status, next)
      ? { status: next, completedAt: null }
      : { status: next },
  });
  return { before: order.status, after: next };
}

/** 撤销与修正共用的主体：校验、作废、重算状态、写事件与审计。全部在 runIdempotent 的同一事务内。 */
async function applyVoid(
  tx: Tx,
  request: FastifyRequest,
  adapter: RecordAdapter,
  mode: 'undo' | 'correct',
  id: string,
  reason: string,
) {
  const auth = authContext(request);
  const record = await adapter.load(tx, id);
  if (record.voidedAt) {
    throw Errors.conflict('RECORD_ALREADY_VOIDED', `该${adapter.label}记录已作废，不能重复操作`);
  }

  if (mode === 'undo') {
    const isAdmin = auth.user.role === 'ADMIN';
    if (!isAdmin && record.operatorId !== auth.user.id) {
      throw Errors.forbidden(`只能撤销自己录入的${adapter.label}记录`);
    }
    if (!isAdmin && !isWithinUndoWindow(record.createdAt)) {
      throw Errors.conflict(
        'UNDO_WINDOW_EXPIRED',
        '已超过 10 分钟撤销窗口，请由管理员修正',
        { undoableUntil: undoableUntil(record.createdAt).toISOString() },
      );
    }
  }

  await adapter.guardVoid(tx, record);

  const voidReason =
    mode === 'undo' ? `撤销：${record.quantity} 件${adapter.label}记录` : reason;

  await adapter.voidRecord(tx, record, { actorId: auth.user.id, reason: voidReason });
  const status = await recomputeStatus(tx, record.orderId);
  const order = await tx.order.findUniqueOrThrow({
    where: { id: record.orderId },
    select: { orderNo: true },
  });

  await recordEvent(tx, {
    orderId: record.orderId,
    type: mode === 'undo' ? adapter.eventType.undo : adapter.eventType.correct,
    actorId: auth.user.id,
    payload: {
      recordId: record.id,
      kind: adapter.kind,
      quantity: record.quantity,
      voidReason,
      statusBefore: status.before,
      statusAfter: status.after,
    },
    notify: {
      title:
        mode === 'undo'
          ? `${order.orderNo} ${adapter.label}记录已撤销 ${record.quantity} 件`
          : `${order.orderNo} ${adapter.label}记录已由管理员修正`,
      body:
        status.before === status.after
          ? voidReason
          : `${voidReason}；订单状态 ${status.before} → ${status.after}。`,
      category: adapter.category,
    },
  });

  await writeAudit(tx, {
    requestId: request.id,
    actorId: auth.user.id,
    action: mode === 'undo' ? adapter.auditAction.undo : adapter.auditAction.correct,
    resourceType: adapter.auditResourceType,
    resourceId: record.id,
    before: {
      quantity: record.quantity,
      operatorId: record.operatorId,
      createdAt: record.createdAt.toISOString(),
    },
    after: {
      voidedAt: now().toISOString(),
      voidReason,
      statusBefore: status.before,
      statusAfter: status.after,
    },
  });

  return finish(tx, record.orderId, auth.user.role, auth.user.id, auth.user.departmentId, 200);
}

export async function recordUndoRoutes(app: FastifyInstance): Promise<void> {
  for (const adapter of RECORD_ADAPTERS) {
    app.post(
      `/api/v1/${adapter.path}/:id/undo`,
      { preHandler: authenticate },
      async (request, reply) => {
        const auth = authContext(request);
        const { id } = idParam.parse(request.params);
        const body = emptyBody.parse(request.body ?? {});

        const outcome = await runIdempotent({
          actorId: auth.user.id,
          operation: `${adapter.kind}.undo`,
          key: request.headers['idempotency-key'],
          body: { id, ...body },
          handler: async (tx) => {
            return applyVoid(tx, request, adapter, 'undo', id, '');
          },
        });

        reply.headers(replayHeaders(outcome.replayed));
        return ok(reply, outcome.data);
      },
    );

    app.post(
      `/api/v1/${adapter.path}/:id/correct`,
      { preHandler: [authenticate, requireAdmin] },
      async (request, reply) => {
        const auth = authContext(request);
        const { id } = idParam.parse(request.params);
        const body = correctSchema.parse(request.body);

        const outcome = await runIdempotent({
          actorId: auth.user.id,
          operation: `${adapter.kind}.correct`,
          key: request.headers['idempotency-key'],
          body: { id, reason: body.reason },
          handler: async (tx) => {
            return applyVoid(tx, request, adapter, 'correct', id, body.reason);
          },
        });

        reply.headers(replayHeaders(outcome.replayed));
        return ok(reply, outcome.data);
      },
    );
  }
}

export type { RecordAdapter };
