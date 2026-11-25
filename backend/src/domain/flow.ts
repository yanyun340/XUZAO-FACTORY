import { Prisma } from '../generated/prisma/client.ts';
import type { OrderStatus, Role } from '../generated/prisma/enums.ts';

/**
 * 订单主链所需的完整聚合。
 * 一次查询取回采购、到货、生产、质检、包装、发货记录，供详情页与动作守卫共用。
 */
export const flowInclude = {
  items: true,
  createdBy: { select: { displayName: true } },
  owner: { select: { displayName: true } },
  timelineEvents: {
    orderBy: { createdAt: 'asc' },
    include: { actor: { select: { displayName: true } } },
  },
  platingOrders: {
    orderBy: { createdAt: 'asc' },
    include: { purchaseItem: { select: { partName: true, partSpec: true } } },
  },
  purchaseOrders: {
    orderBy: { createdAt: 'asc' },
    include: {
      items: {
        orderBy: { createdAt: 'asc' },
        include: {
          arrivals: {
            orderBy: { createdAt: 'asc' },
            include: { operator: { select: { displayName: true } } },
          },
          platingOrders: { orderBy: { createdAt: 'asc' } },
        },
      },
    },
  },
  productions: {
    orderBy: { createdAt: 'asc' },
    include: {
      department: { select: { name: true, category: true } },
      employee: { select: { name: true } },
      feedbacks: {
        orderBy: { createdAt: 'asc' },
        include: { operator: { select: { displayName: true } } },
      },
      qcRecords: {
        orderBy: { createdAt: 'asc' },
        include: {
          operator: { select: { displayName: true } },
          decision: { include: { decidedBy: { select: { displayName: true } } } },
        },
      },
    },
  },
  packingRecords: {
    orderBy: { createdAt: 'asc' },
    include: { operator: { select: { displayName: true } } },
  },
  shipments: {
    orderBy: { createdAt: 'asc' },
    include: { operator: { select: { displayName: true } } },
  },
} satisfies Prisma.OrderInclude;

export type OrderFlowRow = Prisma.OrderGetPayload<{ include: typeof flowInclude }>;

/**
 * 列表页只需要算数量与阶段，不需要时间线、操作人姓名等重字段。
 * 与 flowInclude 保持同一张关系图，但砍掉展示用关联。
 */
export const listFlowInclude = {
  items: true,
  owner: { select: { displayName: true } },
  purchaseOrders: {
    include: { items: { include: { arrivals: true, platingOrders: true } } },
  },
  productions: {
    include: { feedbacks: true, qcRecords: { include: { decision: true } } },
  },
  packingRecords: true,
  shipments: true,
} satisfies Prisma.OrderInclude;

export type OrderListRow = Prisma.OrderGetPayload<{ include: typeof listFlowInclude }>;

/** computeQuantities 只依赖这几个集合；列表行与详情行都满足。 */
export type QuantitySource = {
  items: ReadonlyArray<{ quantity: number }>;
  purchaseOrders: ReadonlyArray<{
    items: ReadonlyArray<{
      quantity: number;
      platingRequired?: boolean;
      arrivals: ReadonlyArray<{ quantity: number }>;
      platingOrders?: ReadonlyArray<{ quantity: number; status: string }>;
    }>;
  }>;
  productions: ReadonlyArray<{
    feedbacks: ReadonlyArray<{ quantity: number }>;
    qcRecords: ReadonlyArray<{
      id: string;
      inspectedQty: number;
      qualifiedQty: number;
      unqualifiedQty: number;
      round: number;
      parentQcRecordId: string | null;
      decision: { decision: string; releasedQty: number; scrapQty: number } | null;
    }>;
  }>;
  packingRecords: ReadonlyArray<{ quantity: number }>;
  shipments: ReadonlyArray<{ quantity: number }>;
};

/** 数量口径：全部来自有效业务记录求和，不依赖可被前端改写的汇总字段。 */
export interface FlowQuantities {
  orderQty: number;
  purchaseQty: number;
  arrivedQty: number;
  platingRequiredQty: number;
  platingSentQty: number;
  platingReceivedQty: number;
  platingOutstandingQty: number;
  producedQty: number;
  inspectedQty: number;
  qualifiedQty: number;
  releasedQty: number;
  scrappedQty: number;
  /** R09F：已判返工、尚未复检的数量。 */
  reworkPendingQty: number;
  /** 已录入但管理员尚未决策的检验量；此时不能再录入新一轮。 */
  undecidedQty: number;
  packedQty: number;
  shippedQty: number;
  dueRemaining: number;
  packableRemaining: number;
  shippableRemaining: number;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

export function computeQuantities(order: QuantitySource): FlowQuantities {
  const orderQty = sum(order.items.map((item) => item.quantity));
  const purchaseQty = sum(
    order.purchaseOrders.flatMap((po) => po.items.map((item) => item.quantity)),
  );
  const arrivedQty = sum(
    order.purchaseOrders.flatMap((po) =>
      po.items.flatMap((item) => item.arrivals.map((arrival) => arrival.quantity)),
    ),
  );
  const production = order.productions.at(-1);
  const producedQty = sum((production?.feedbacks ?? []).map((feedback) => feedback.quantity));

  const qcRecords = order.productions.flatMap((p) => p.qcRecords);
  // R09F：首检可能分多批；复检记录单独成轮，不影响首检累计。
  const inspectedQty = sum(qcRecords.filter((record) => record.round === 1).map((record) => record.inspectedQty));
  const qualifiedQty = sum(qcRecords.map((record) => record.qualifiedQty));
  const releasedQty = sum(
    qcRecords.flatMap((record) => (record.decision ? [record.decision.releasedQty] : [])),
  );
  const scrappedQty = sum(
    qcRecords.flatMap((record) => (record.decision ? [record.decision.scrapQty] : [])),
  );
  const undecidedQty = sum(
    qcRecords.filter((record) => !record.decision).map((record) => record.inspectedQty),
  );
  // 每张返工决策的可复检量 = 不合格量 − 已复检量；累计到仍未复检的返工量。
  const reworkPendingQty = sum(
    qcRecords.flatMap((record) => {
      if (record.decision?.decision !== 'REWORK') return [0];
      const reinspected = sum(
        qcRecords
          .filter((child) => child.parentQcRecordId === record.id)
          .map((child) => child.inspectedQty),
      );
      return [Math.max(0, record.unqualifiedQty - reinspected)];
    }),
  );
  const packedQty = sum(order.packingRecords.map((record) => record.quantity));
  const shippedQty = sum(order.shipments.map((record) => record.quantity));

  const purchaseItems = order.purchaseOrders.flatMap((po) => po.items);
  const platingRequiredQty = sum(
    purchaseItems.filter((item) => item.platingRequired === true).map((item) => item.quantity),
  );
  const platingSentQty = sum(
    purchaseItems.flatMap((item) =>
      (item.platingOrders ?? [])
        .filter((plating) => plating.status === 'SENT' || plating.status === 'RECEIVED')
        .map((plating) => plating.quantity),
    ),
  );
  const platingReceivedQty = sum(
    purchaseItems.flatMap((item) =>
      (item.platingOrders ?? [])
        .filter((plating) => plating.status === 'RECEIVED')
        .map((plating) => plating.quantity),
    ),
  );

  return {
    orderQty,
    purchaseQty,
    arrivedQty,
    platingRequiredQty,
    platingSentQty,
    platingReceivedQty,
    platingOutstandingQty: Math.max(0, platingRequiredQty - platingReceivedQty),
    producedQty,
    inspectedQty,
    qualifiedQty,
    releasedQty,
    scrappedQty,
    reworkPendingQty,
    undecidedQty,
    packedQty,
    shippedQty,
    dueRemaining: Math.max(0, orderQty - shippedQty),
    packableRemaining: Math.max(0, releasedQty - packedQty),
    shippableRemaining: Math.max(0, packedQty - shippedQty),
  };
}

export interface ProfitSummary {
  sales: string;
  purchaseCost: string;
  productionCost: string;
  platingCost: string;
  profit: string;
  marginPercent: string;
}

/** 预计利润：订单快照口径，不代表收款或付款。 */
export function computeProfit(order: OrderFlowRow): ProfitSummary {
  const sales = order.items.reduce(
    (total, item) => total.plus(item.unitPrice.times(item.quantity)),
    new Prisma.Decimal(0),
  );
  const purchaseCost = order.purchaseOrders
    .flatMap((po) => po.items)
    .reduce(
      (total, item) => total.plus(item.unitPrice.times(item.quantity)),
      new Prisma.Decimal(0),
    );
  const productionCost = order.productions.reduce((total, production) => {
    const completed = production.feedbacks.reduce((qty, feedback) => qty + feedback.quantity, 0);
    return total.plus(production.unitPrice.times(completed));
  }, new Prisma.Decimal(0));

  // R06F：只统计已收货的电镀单；已发送未收回不计入。
  const platingCost = (order.platingOrders ?? [])
    .filter((plating) => plating.status === 'RECEIVED')
    .reduce(
      (total, plating) => total.plus(plating.unitPrice.times(plating.quantity)),
      new Prisma.Decimal(0),
    );

  const profit = sales.minus(purchaseCost).minus(productionCost).minus(platingCost);
  const margin = sales.isZero() ? new Prisma.Decimal(0) : profit.div(sales).times(100);

  return {
    sales: sales.toFixed(2),
    purchaseCost: purchaseCost.toFixed(2),
    productionCost: productionCost.toFixed(2),
    platingCost: platingCost.toFixed(2),
    profit: profit.toFixed(2),
    marginPercent: margin.toDecimalPlaces(2).toFixed(2),
  };
}

export type OrderAction =
  | 'create-purchase'
  | 'record-arrival'
  | 'send-plating'
  | 'receive-plating'
  | 'dispatch-production'
  | 'production-feedback'
  | 'dispatch-qc'
  | 'qc-entry'
  | 'qc-decision'
  | 'dispatch-packing'
  | 'record-packing'
  | 'trigger-shipping'
  | 'record-shipment';

/**
 * 动作守卫只需要「状态 + 采购单 + 生产任务（含部门）+ 数量」。
 * 列表行、详情行都满足，待办队列因此不必拉完整聚合。
 */
export type ActionSource = Omit<QuantitySource, 'productions'> & {
  status: OrderStatus;
  productions: ReadonlyArray<
    QuantitySource['productions'][number] & { departmentId: string }
  >;
};

/**
 * 允许动作由后端按「角色 + 状态 + 已发生记录 + 数量闸门」计算。
 * 前端只负责渲染，任何动作提交时都会再次校验。
 */
export function computeAllowedActions(
  order: ActionSource,
  quantities: FlowQuantities,
  role: Role,
  userId: string,
  departmentId: string | null,
): OrderAction[] {
  const actions: OrderAction[] = [];
  const purchase = order.purchaseOrders[0] ?? null;
  const production = order.productions.at(-1) ?? null;
  const feedback = production?.feedbacks.at(-1) ?? null;
  const hasInitialQc = production?.qcRecords.some((record) => record.round === 1) ?? false;

  if (role === 'ADMIN') {
    if (order.status === 'PENDING_PURCHASE' && !purchase) actions.push('create-purchase');
    if (
      order.status === 'PURCHASING' &&
      purchase &&
      quantities.purchaseQty > 0 &&
      quantities.arrivedQty >= quantities.purchaseQty &&
      (quantities.platingRequiredQty === 0 || quantities.platingReceivedQty > 0) &&
      !production
    ) {
      actions.push('dispatch-production');
    }
    if (order.status === 'IN_PRODUCTION' && feedback && feedback.quantity > 0 && !hasInitialQc) {
      actions.push('dispatch-qc');
    }
    if (order.status === 'PENDING_QC' && quantities.undecidedQty > 0) actions.push('qc-decision');
    if (order.status === 'QC_DONE' && quantities.packableRemaining > 0) actions.push('dispatch-packing');
    if (order.status === 'PACKING' && quantities.packedQty > 0) actions.push('trigger-shipping');
  }

  if (role === 'LOGISTICS') {
    if (
      purchase &&
      order.status === 'PURCHASING' &&
      quantities.arrivedQty < quantities.purchaseQty
    ) {
      actions.push('record-arrival');
    }
    // R06F：物流在采购阶段负责电镀外协的发送与收回。
    const platingOrders = order.purchaseOrders.flatMap((po) =>
      po.items.flatMap((item) => item.platingOrders ?? []),
    );
    if (order.status === 'PURCHASING') {
      if (platingOrders.some((plating) => plating.status === 'PENDING')) {
        actions.push('send-plating');
      } else if (platingOrders.some((plating) => plating.status === 'SENT')) {
        actions.push('receive-plating');
      }
    }
    if (order.status === 'SHIPPING' && quantities.shippableRemaining > 0) {
      actions.push('record-shipment');
    }
  }

  if (role === 'PRODUCTION') {
    if (
      order.status === 'IN_PRODUCTION' &&
      production &&
      !feedback &&
      departmentId !== null &&
      production.departmentId === departmentId
    ) {
      actions.push('production-feedback');
    }
  }

  // R09F：首检可分多批（检验完剩余产量），返工量也可继续复检；
  // 但只要上一轮结果还没被管理员决策，就不能再录新一轮。
  if (
    role === 'QC' &&
    order.status === 'PENDING_QC' &&
    production &&
    quantities.undecidedQty === 0 &&
    (quantities.inspectedQty < quantities.producedQty || quantities.reworkPendingQty > 0)
  ) {
    actions.push('qc-entry');
  }

  if (role === 'PACKING' && order.status === 'PACKING' && quantities.packableRemaining > 0) {
    actions.push('record-packing');
  }

  // 未使用的入参保持签名稳定，便于后续按个人分配细化
  void userId;

  return actions;
}