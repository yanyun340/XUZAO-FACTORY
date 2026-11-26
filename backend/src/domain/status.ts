import type { OrderStatus } from '../generated/prisma/enums.ts';
import type { FlowQuantities } from './flow.ts';

/**
 * R12F：撤销/作废后的状态修复事实。
 * 只放「数量算不出来、必须查库」的布尔事实，其余全部由 FlowQuantities 决定。
 */
export interface RepairFacts {
  /** 该生产任务下是否还有非作废质检记录。 */
  hasActiveQcRecord: boolean;
  /** 是否有 WAITING_QC 异常正在等待这次质检结果。 */
  hasWaitingQcException: boolean;
}

/**
 * R12F：状态回退。
 *
 * 状态机本身是单向的（见 docs/state-and-quantity.md），撤销记录后只允许三条反向边，
 * 多退一步就是凭空造状态。其余状态一律保持不变：
 * - PACKING 在 packedQty 归零后仍是 PACKING，允许动作由数量闸门自己挡住；
 * - SHIPPING 在 shippedQty 归零后仍是 SHIPPING，理由同上；
 * - 一旦 COMPLETED 被撤销发货退回 SHIPPING，不会再继续往 PACKING 退。
 *
 * 三条反向边可以级联（QC_DONE → PENDING_QC → IN_PRODUCTION），顺序评估一次即可。
 */
export function deriveRepairedStatus(
  current: OrderStatus,
  quantities: FlowQuantities,
  facts: RepairFacts,
): OrderStatus {
  let next: OrderStatus = current;

  // 1) 发货量不足订单量：订单不能算完成。completedAt 由调用方在同一事务内清空。
  if (next === 'COMPLETED' && quantities.shippedQty < quantities.orderQty) {
    next = 'SHIPPING';
  }

  // 2) 质检不再结算：没有产量，或还有未决策记录，或放行 + 报废 < 已生产。
  // 没有产量时不能空转——此时一定不结算，直接进入第 3 条退回生产。
  if (next === 'QC_DONE') {
    const settled =
      quantities.producedQty > 0 &&
      quantities.releasedQty + quantities.scrappedQty >= quantities.producedQty &&
      quantities.undecidedQty === 0;
    if (!settled) next = 'PENDING_QC';
  }

  // 3) 没有任何产量、没有质检记录、也没有等待质检的异常：退回生产中。
  if (next === 'PENDING_QC') {
    const empty =
      quantities.producedQty === 0 &&
      !facts.hasActiveQcRecord &&
      !facts.hasWaitingQcException;
    if (empty) next = 'IN_PRODUCTION';
  }

  return next;
}

/** 状态回退是否需要清空 completedAt。 */
export function clearsCompletedAt(from: OrderStatus, to: OrderStatus): boolean {
  return from === 'COMPLETED' && to !== 'COMPLETED';
}
