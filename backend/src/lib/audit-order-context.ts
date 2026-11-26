import { prisma } from '../db.ts';

export interface AuditOrderContext {
  orderId: string;
  orderNo: string;
}

type AuditRowRef = { resourceType: string; resourceId: string | null };

const CHUNK_SIZE = 500;

function chunks<T>(values: T[], size = CHUNK_SIZE): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function key(resourceType: string, resourceId: string): string {
  return `${resourceType}:${resourceId}`;
}

/**
 * 审计列表/导出用的订单上下文解析。
 * resourceId 是业务记录自己的 ID，这里读取时反查所属订单，
 * 不新增数据库字段，也不影响历史记录。
 */
export async function resolveAuditOrderContexts(
  rows: AuditRowRef[],
): Promise<Map<string, AuditOrderContext>> {
  const contexts = new Map<string, AuditOrderContext>();

  const idsByType = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!row.resourceId) continue;
    const set = idsByType.get(row.resourceType) ?? new Set<string>();
    set.add(row.resourceId);
    idsByType.set(row.resourceType, set);
  }

  const ids = (type: string) => [...(idsByType.get(type) ?? [])];

  const orderBatches = chunks(ids('order')).map((batch) =>
    prisma.order.findMany({
      where: { id: { in: batch } },
      select: { id: true, orderNo: true },
    }),
  );

  const purchaseBatches = chunks(ids('purchase')).map((batch) =>
    prisma.purchaseOrder.findMany({
      where: { id: { in: batch } },
      select: { id: true, orderId: true, order: { select: { orderNo: true } } },
    }),
  );

  const arrivalBatches = chunks(ids('arrival')).map((batch) =>
    prisma.arrivalRecord.findMany({
      where: { id: { in: batch } },
      select: {
        id: true,
        purchaseItem: {
          select: {
            purchaseOrder: {
              select: { orderId: true, order: { select: { orderNo: true } } },
            },
          },
        },
      },
    }),
  );

  const productionBatches = chunks(ids('production')).map((batch) =>
    prisma.productionOrder.findMany({
      where: { id: { in: batch } },
      select: { id: true, orderId: true, order: { select: { orderNo: true } } },
    }),
  );

  const qcBatches = chunks(ids('qc')).map((batch) =>
    prisma.qCRecord.findMany({
      where: { id: { in: batch } },
      select: {
        id: true,
        productionOrder: {
          select: { orderId: true, order: { select: { orderNo: true } } },
        },
      },
    }),
  );

  // R12F：生产反馈撤销/修正的审计 resourceId 是反馈记录 id（既有 production.feedback
  // 审计记的是生产任务 id），需要单独反查，否则审计页「订单」列显示 —。
  const productionFeedbackBatches = chunks(ids('production_feedback')).map((batch) =>
    prisma.productionFeedback.findMany({
      where: { id: { in: batch } },
      select: {
        id: true,
        productionOrder: {
          select: { orderId: true, order: { select: { orderNo: true } } },
        },
      },
    }),
  );

  const qcDecisionBatches = chunks(ids('qc_decision')).map((batch) =>
    prisma.qCDecision.findMany({
      where: { id: { in: batch } },
      select: {
        id: true,
        qcRecord: {
          select: {
            productionOrder: {
              select: { orderId: true, order: { select: { orderNo: true } } },
            },
          },
        },
      },
    }),
  );

  const packingBatches = chunks(ids('packing')).map((batch) =>
    prisma.packingRecord.findMany({
      where: { id: { in: batch } },
      select: { id: true, orderId: true, order: { select: { orderNo: true } } },
    }),
  );

  const shipmentBatches = chunks(ids('shipment')).map((batch) =>
    prisma.shipmentRecord.findMany({
      where: { id: { in: batch } },
      select: { id: true, orderId: true, order: { select: { orderNo: true } } },
    }),
  );

  const platingBatches = chunks(ids('plating_order')).map((batch) =>
    prisma.platingOrder.findMany({
      where: { id: { in: batch } },
      select: { id: true, orderId: true, order: { select: { orderNo: true } } },
    }),
  );

  const exceptionBatches = chunks(ids('exception')).map((batch) =>
    prisma.tabletException.findMany({
      where: { id: { in: batch } },
      select: { id: true, orderId: true, order: { select: { orderNo: true } } },
    }),
  );

  const attachmentBatches = chunks(ids('attachment')).map((batch) =>
    prisma.attachment.findMany({
      where: { id: { in: batch } },
      select: { id: true, ownerType: true, ownerId: true },
    }),
  );

  const [
    orderRows,
    purchaseRows,
    arrivalRows,
    productionRows,
    productionFeedbackRows,
    qcRows,
    qcDecisionRows,
    packingRows,
    shipmentRows,
    platingRows,
    exceptionRows,
    attachmentRows,
  ] = await Promise.all([
    Promise.all(orderBatches).then((batches) => batches.flat()),
    Promise.all(purchaseBatches).then((batches) => batches.flat()),
    Promise.all(arrivalBatches).then((batches) => batches.flat()),
    Promise.all(productionBatches).then((batches) => batches.flat()),
    Promise.all(productionFeedbackBatches).then((batches) => batches.flat()),
    Promise.all(qcBatches).then((batches) => batches.flat()),
    Promise.all(qcDecisionBatches).then((batches) => batches.flat()),
    Promise.all(packingBatches).then((batches) => batches.flat()),
    Promise.all(shipmentBatches).then((batches) => batches.flat()),
    Promise.all(platingBatches).then((batches) => batches.flat()),
    Promise.all(exceptionBatches).then((batches) => batches.flat()),
    Promise.all(attachmentBatches).then((batches) => batches.flat()),
  ]);

  for (const row of orderRows) {
    contexts.set(key('order', row.id), { orderId: row.id, orderNo: row.orderNo });
  }
  for (const row of purchaseRows) {
    contexts.set(key('purchase', row.id), { orderId: row.orderId, orderNo: row.order.orderNo });
  }
  for (const row of arrivalRows) {
    const order = row.purchaseItem.purchaseOrder.order;
    contexts.set(key('arrival', row.id), {
      orderId: row.purchaseItem.purchaseOrder.orderId,
      orderNo: order.orderNo,
    });
  }
  for (const row of productionRows) {
    contexts.set(key('production', row.id), { orderId: row.orderId, orderNo: row.order.orderNo });
  }
  for (const row of productionFeedbackRows) {
    contexts.set(key('production_feedback', row.id), {
      orderId: row.productionOrder.orderId,
      orderNo: row.productionOrder.order.orderNo,
    });
  }
  for (const row of qcRows) {
    contexts.set(key('qc', row.id), {
      orderId: row.productionOrder.orderId,
      orderNo: row.productionOrder.order.orderNo,
    });
  }
  for (const row of qcDecisionRows) {
    contexts.set(key('qc_decision', row.id), {
      orderId: row.qcRecord.productionOrder.orderId,
      orderNo: row.qcRecord.productionOrder.order.orderNo,
    });
  }
  for (const row of packingRows) {
    contexts.set(key('packing', row.id), { orderId: row.orderId, orderNo: row.order.orderNo });
  }
  for (const row of shipmentRows) {
    contexts.set(key('shipment', row.id), { orderId: row.orderId, orderNo: row.order.orderNo });
  }
  for (const row of platingRows) {
    contexts.set(key('plating_order', row.id), {
      orderId: row.orderId,
      orderNo: row.order.orderNo,
    });
  }
  for (const row of exceptionRows) {
    if (!row.orderId) continue;
    contexts.set(key('exception', row.id), {
      orderId: row.orderId,
      orderNo: row.order?.orderNo ?? '',
    });
  }

  // 附件按 ownerType 再解析一层，支持订单/采购/生产/质检/发货五类挂载。
  const attachmentByType = new Map<string, Array<{ id: string; ownerId: string }>>();
  for (const row of attachmentRows) {
    const list = attachmentByType.get(row.ownerType) ?? [];
    list.push({ id: row.id, ownerId: row.ownerId });
    attachmentByType.set(row.ownerType, list);
  }

  const attachmentLookups = await Promise.all(
    [...attachmentByType.entries()].map(async ([ownerType, items]) => {
      const ownerIds = items.map((item) => item.ownerId);
      const byOwner = new Map<string, AuditOrderContext>();

      if (ownerType === 'order') {
        const owners = await prisma.order.findMany({
          where: { id: { in: ownerIds } },
          select: { id: true, orderNo: true },
        });
        for (const owner of owners) {
          byOwner.set(owner.id, { orderId: owner.id, orderNo: owner.orderNo });
        }
      } else if (ownerType === 'purchase') {
        const owners = await prisma.purchaseOrder.findMany({
          where: { id: { in: ownerIds } },
          select: { id: true, orderId: true, order: { select: { orderNo: true } } },
        });
        for (const owner of owners) {
          byOwner.set(owner.id, { orderId: owner.orderId, orderNo: owner.order.orderNo });
        }
      } else if (ownerType === 'production') {
        const owners = await prisma.productionOrder.findMany({
          where: { id: { in: ownerIds } },
          select: { id: true, orderId: true, order: { select: { orderNo: true } } },
        });
        for (const owner of owners) {
          byOwner.set(owner.id, { orderId: owner.orderId, orderNo: owner.order.orderNo });
        }
      } else if (ownerType === 'qc') {
        const owners = await prisma.qCRecord.findMany({
          where: { id: { in: ownerIds } },
          select: {
            id: true,
            productionOrder: {
              select: { orderId: true, order: { select: { orderNo: true } } },
            },
          },
        });
        for (const owner of owners) {
          byOwner.set(owner.id, {
            orderId: owner.productionOrder.orderId,
            orderNo: owner.productionOrder.order.orderNo,
          });
        }
      } else if (ownerType === 'shipment') {
        const owners = await prisma.shipmentRecord.findMany({
          where: { id: { in: ownerIds } },
          select: { id: true, orderId: true, order: { select: { orderNo: true } } },
        });
        for (const owner of owners) {
          byOwner.set(owner.id, { orderId: owner.orderId, orderNo: owner.order.orderNo });
        }
      }

      return { items, byOwner };
    }),
  );

  for (const { items, byOwner } of attachmentLookups) {
    for (const item of items) {
      const context = byOwner.get(item.ownerId);
      if (context) contexts.set(key('attachment', item.id), context);
    }
  }

  return contexts;
}