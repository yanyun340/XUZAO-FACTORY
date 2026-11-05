import { describe, expect, it } from 'vitest';
import { Prisma } from '../src/generated/prisma/client.ts';
import { computeAllowedActions, computeProfit, computeQuantities } from '../src/domain/flow.ts';
import type { OrderFlowRow } from '../src/domain/flow.ts';

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