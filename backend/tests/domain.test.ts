import { describe, expect, it } from 'vitest';
import { Prisma } from '../src/generated/prisma/client.ts';
import { computeAllowedActions, computeProfit, computeQuantities } from '../src/domain/flow.ts';
import { computeStages, toTaskItem } from '../src/domain/orders.ts';
import type { OrderFlowRow, OrderListRow } from '../src/domain/flow.ts';

const D = (value: string) => new Prisma.Decimal(value);

function makeOrder(input: {
  orderQty?: number;
  purchaseQty?: number;
  arrivedQty?: number;
  producedQty?: number;
  releasedQty?: number;
  packedQty?: number;
  shippedQty?: number;
  status?: string;
  productionDepartmentId?: string;
  hasPurchase?: boolean;
  hasProduction?: boolean;
  hasFeedback?: boolean;
  hasQc?: boolean;
  hasDecision?: boolean;
} = {}): OrderFlowRow {
  const order = {
    status: input.status ?? 'PENDING_PURCHASE',
    dueDate: new Date('2026-12-01T00:00:00.000Z'),
    createdAt: new Date('2026-11-01T00:00:00.000Z'),
    updatedAt: new Date('2026-11-01T00:00:00.000Z'),
    items: [{ quantity: input.orderQty ?? 100, unitPrice: D('12.50') }],
    purchaseOrders:
      input.hasPurchase === false
        ? []
        : [
            {
              items: [
                {
                  quantity: input.purchaseQty ?? 100,
                  unitPrice: D('5.00'),
                  arrivals: [{ quantity: input.arrivedQty ?? 100 }],
                },
              ],
            },
          ],
    productions:
      input.hasProduction === false
        ? []
        : [
            {
              departmentId: input.productionDepartmentId ?? 'dept-prod',
              quantity: 100,
              unitPrice: D('2.00'),
              feedbacks: input.hasFeedback === false ? [] : [{ quantity: input.producedQty ?? 100 }],
              qcRecords: input.hasQc
                ? [
                    {
                      inspectedQty: 100,
                      qualifiedQty: input.releasedQty ?? 100,
                      unqualifiedQty: 0,
                      decision: input.hasDecision
                        ? { releasedQty: input.releasedQty ?? 100 }
                        : null,
                    },
                  ]
                : [],
            },
          ],
    packingRecords: [{ quantity: input.packedQty ?? 0 }],
    shipments: [{ quantity: input.shippedQty ?? 0 }],
  };

  return order as unknown as OrderFlowRow;
}

describe('数量口径', () => {
  it('可包装剩余 = 放行量 - 已包装量', () => {
    const q = computeQuantities(makeOrder({ releasedQty: 80, packedQty: 50, hasQc: true, hasDecision: true }));
    expect(q.releasedQty).toBe(80);
    expect(q.packableRemaining).toBe(30);
  });

  it('可发货剩余 = 已包装量 - 已发货量', () => {
    const q = computeQuantities(makeOrder({ packedQty: 50, shippedQty: 20 }));
    expect(q.shippableRemaining).toBe(30);
  });

  it('应交剩余 = 订单量 - 已发货量，且不会为负', () => {
    const q = computeQuantities(makeOrder({ orderQty: 100, shippedQty: 40 }));
    expect(q.dueRemaining).toBe(60);

    const over = computeQuantities(makeOrder({ orderQty: 10, shippedQty: 10 }));
    expect(over.dueRemaining).toBe(0);
  });

  it('没有放行记录时可包装剩余为 0', () => {
    const q = computeQuantities(makeOrder({ releasedQty: 0, packedQty: 0, hasQc: true }));
    expect(q.packableRemaining).toBe(0);
  });

  it('到货量按多条到货记录累加', () => {
    const order = makeOrder();
    const po = order.purchaseOrders[0]!;
    po.items[0]!.arrivals = [{ quantity: 40 }, { quantity: 60 }] as never;
    expect(computeQuantities(order).arrivedQty).toBe(100);
  });
});

describe('利润口径', () => {
  it('利润 = 销售额 - 采购成本 - 有效完成量的生产成本', () => {
    const profit = computeProfit(makeOrder({ producedQty: 80 }));
    expect(profit.sales).toBe('1250.00');
    expect(profit.purchaseCost).toBe('500.00');
    expect(profit.productionCost).toBe('160.00');
    expect(profit.profit).toBe('590.00');
    expect(profit.marginPercent).toBe('47.20');
  });

  it('用 Decimal 计算，不出现浮点误差', () => {
    const order = makeOrder();
    order.items[0]!.unitPrice = D('0.10');
    order.items[0]!.quantity = 3;
    const profit = computeProfit(order);
    expect(profit.sales).toBe('0.30');
  });

  it('销售额为 0 时毛利率为 0，不会除零', () => {
    const order = makeOrder({ hasPurchase: false, hasProduction: false });
    order.items[0]!.unitPrice = D('0');
    expect(computeProfit(order).marginPercent).toBe('0.00');
  });
});

describe('允许动作', () => {
  it('管理员在待采购状态只能建采购', () => {
    const order = makeOrder({ hasPurchase: false, hasProduction: false });
    expect(computeAllowedActions(order, computeQuantities(order), 'ADMIN', 'u1', null)).toEqual([
      'create-purchase',
    ]);
  });

  it('采购未到齐时管理员不能下发生产', () => {
    const order = makeOrder({ status: 'PURCHASING', arrivedQty: 60 });
    const actions = computeAllowedActions(order, computeQuantities(order), 'ADMIN', 'u1', null);
    expect(actions).not.toContain('dispatch-production');
  });

  it('采购到齐后管理员可以下发生产', () => {
    const order = makeOrder({ status: 'PURCHASING', hasProduction: false });
    const actions = computeAllowedActions(order, computeQuantities(order), 'ADMIN', 'u1', null);
    expect(actions).toContain('dispatch-production');
  });

  it('生产反馈只对同部门角色开放', () => {
    const order = makeOrder({ status: 'IN_PRODUCTION', hasFeedback: false });
    const q = computeQuantities(order);
    expect(computeAllowedActions(order, q, 'PRODUCTION', 'u2', 'dept-prod')).toContain(
      'production-feedback',
    );
    expect(computeAllowedActions(order, q, 'PRODUCTION', 'u2', 'dept-other')).not.toContain(
      'production-feedback',
    );
  });

  it('现场角色拿不到管理员的动作', () => {
    const order = makeOrder({
      status: 'PACKING',
      hasQc: true,
      hasDecision: true,
      releasedQty: 100,
      packedQty: 10,
    });
    const actions = computeAllowedActions(order, computeQuantities(order), 'PACKING', 'u3', null);
    expect(actions).toEqual(['record-packing']);
  });
});
describe('六段工序色带', () => {
  const TODAY = '2026-11-09';
  const states = (order: OrderFlowRow, dueDate: string) =>
    computeStages(computeQuantities(order), order.status, dueDate, TODAY).map((stage) => stage.state);

  it('待采购：采购是当前工序，其余待办', () => {
    const order = makeOrder({ status: 'PENDING_PURCHASE', hasPurchase: false, hasProduction: false });
    expect(states(order, '2026-12-01')).toEqual([
      'doing',
      'todo',
      'todo',
      'todo',
      'todo',
      'todo',
    ]);
  });

  it('采购中且已到货：采购与到货标为完成', () => {
    const order = makeOrder({ status: 'PURCHASING', purchaseQty: 100, arrivedQty: 100 });
    const s = states(order, '2026-12-01');
    expect(s[0]).toBe('done');
    expect(s[1]).toBe('done');
  });

  it('部分到货：到货段保持当前工序', () => {
    const order = makeOrder({ status: 'PURCHASING', purchaseQty: 100, arrivedQty: 40 });
    const s = states(order, '2026-12-01');
    expect(s[1]).toBe('doing');
  });

  it('逾期且停在待质检：质检段标红', () => {
    const order = makeOrder({
      status: 'PENDING_QC',
      hasFeedback: true,
      producedQty: 100,
      hasQc: false,
    });
    expect(states(order, '2026-10-01')[3]).toBe('blocked');
  });

  it('未逾期时同一工序为进行中', () => {
    const order = makeOrder({
      status: 'PENDING_QC',
      hasFeedback: true,
      producedQty: 100,
      hasQc: false,
    });
    expect(states(order, '2026-12-01')[3]).toBe('doing');
  });

  it('当前工序没动过工时写「待…」，不谎报进行中', () => {
    const labels = (order: OrderFlowRow, dueDate: string) =>
      computeStages(computeQuantities(order), order.status, dueDate, TODAY).map((stage) => stage.label);

    const fresh = labels(
      makeOrder({ status: 'PENDING_PURCHASE', hasPurchase: false, hasProduction: false }),
      '2026-12-01',
    );
    expect(fresh[0]).toBe('待采购');

    const awaiting = labels(
      makeOrder({ status: 'PURCHASING', purchaseQty: 100, arrivedQty: 0 }),
      '2026-12-01',
    );
    expect(awaiting[1]).toBe('待到货');

    const partial = labels(
      makeOrder({ status: 'PURCHASING', purchaseQty: 100, arrivedQty: 40 }),
      '2026-12-01',
    );
    expect(partial[1]).toBe('部分到货');

    const pendingQc = labels(
      makeOrder({ status: 'PENDING_QC', hasFeedback: true, producedQty: 100, hasQc: false }),
      '2026-12-01',
    );
    expect(pendingQc[3]).toBe('待质检');
  });

  it('已完成订单六段全部完成', () => {
    const order = makeOrder({
      status: 'COMPLETED',
      hasQc: true,
      hasDecision: true,
      releasedQty: 100,
      packedQty: 100,
      shippedQty: 100,
    });
    expect(states(order, '2026-10-01')).toEqual(Array(6).fill('done'));
  });
});

describe('待办队列', () => {
  const TODAY = '2026-11-09';
  const task = (order: OrderFlowRow, role: Parameters<typeof toTaskItem>[1], departmentId: string | null = null) =>
    toTaskItem(order as unknown as OrderListRow, role, 'u1', departmentId, TODAY);

  it('质检待办带质检录入动作，数量 = 已报工量', () => {
    const order = makeOrder({
      status: 'PENDING_QC',
      hasFeedback: true,
      producedQty: 100,
      hasQc: false,
    });
    const item = task(order, 'QC');
    expect(item?.action).toBe('qc-entry');
    expect(item?.taskQty).toBe(100);
    expect(item?.stages).toHaveLength(6);
  });

  it('包装待办数量 = 可包装剩余', () => {
    const order = makeOrder({
      status: 'PACKING',
      hasQc: true,
      hasDecision: true,
      releasedQty: 80,
      packedQty: 50,
    });
    const item = task(order, 'PACKING');
    expect(item?.action).toBe('record-packing');
    expect(item?.taskQty).toBe(30);
  });

  it('物流到货待办数量 = 采购量 - 已到货量', () => {
    const order = makeOrder({ status: 'PURCHASING', purchaseQty: 100, arrivedQty: 40 });
    const item = task(order, 'LOGISTICS');
    expect(item?.action).toBe('record-arrival');
    expect(item?.taskQty).toBe(60);
  });

  it('管理员待采购待办数量 = 订单量', () => {
    const order = makeOrder({ status: 'PENDING_PURCHASE', hasPurchase: false, hasProduction: false });
    const item = task(order, 'ADMIN');
    expect(item?.action).toBe('create-purchase');
    expect(item?.taskQty).toBe(100);
  });

  it('别的部门的生产任务不进当前生产角色待办', () => {
    const order = makeOrder({ status: 'IN_PRODUCTION', hasFeedback: false });
    expect(task(order, 'PRODUCTION', 'dept-other')).toBeNull();
    expect(task(order, 'PRODUCTION', 'dept-prod')?.action).toBe('production-feedback');
  });

  it('无可执行动作的订单不进待办', () => {
    const order = makeOrder({ status: 'PENDING_PURCHASE', hasPurchase: false, hasProduction: false });
    expect(task(order, 'QC')).toBeNull();
  });
});
