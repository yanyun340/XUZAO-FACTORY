import { useEffect, useRef, useState } from 'react';
import { ApiError, apiGetPage, apiPost } from '../api/client';
import type {
  Department,
  OrderAction,
  OrderDetail,
  Part,
  Supplier,
} from '../api/types';
import { formatMoney } from '../lib/format';
import { ArrowRight, CheckIcon } from './Icons';
import { Button, Field, InlineNotice } from './ui';

interface PanelProps {
  order: OrderDetail;
  onUpdated: (detail: OrderDetail) => void;
}

interface Ctx {
  order: OrderDetail;
  pending: OrderAction | null;
  run: (action: OrderAction, path: string, body: unknown) => void;
}

const ACTION_LABEL: Partial<Record<OrderAction, string>> = {
  'create-purchase': '创建采购单',
  'record-arrival': '登记到货',
  'dispatch-production': '下发生产',
  'production-feedback': '反馈完成数量',
  'dispatch-qc': '下发质检',
  'qc-entry': '录入质检结果',
  'qc-decision': '放行决策',
  'dispatch-packing': '下发包装',
  'record-packing': '登记包装',
  'trigger-shipping': '触发发货',
  'record-shipment': '登记发货',
};

function toInt(value: string): number | null {
  if (!/^\d+$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function useStock<T>(path: string | null): T[] {
  const [items, setItems] = useState<T[]>([]);
  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    apiGetPage<T[]>(path)
      .then((result) => {
        if (!cancelled) setItems(result.data);
      })
      .catch(() => {
        if (!cancelled) setItems([]);
      });
    return () => {
      cancelled = true;
    };
  }, [path]);
  return items;
}

/* ---------- 采购 ---------- */
function PurchaseForm({ ctx }: { ctx: Ctx }) {
  const suppliers = useStock<Supplier>('/suppliers?active=true&pageSize=200');
  const parts = useStock<Part>('/parts?active=true&pageSize=200');
  const [supplierId, setSupplierId] = useState('');
  const [partId, setPartId] = useState('');
  const [quantity, setQuantity] = useState(String(ctx.order.flow.quantities.orderQty || 1));
  const [unitPrice, setUnitPrice] = useState('');

  const qty = toInt(quantity);
  const priceOk = /^(0|[1-9]\d{0,9})(\.\d{1,2})?$/.test(unitPrice.trim());
  const ready = supplierId !== '' && partId !== '' && qty !== null && priceOk;

  return (
    <div className="flow-form">
      <Field label="供应商" htmlFor="flow-supplier" required>
        <select
          id="flow-supplier"
          className="select"
          value={supplierId}
          onChange={(event) => setSupplierId(event.target.value)}
        >
          <option value="">选择供应商</option>
          {suppliers.map((supplier) => (
            <option key={supplier.id} value={supplier.id}>
              {supplier.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="配件" htmlFor="flow-part" required>
        <select
          id="flow-part"
          className="select"
          value={partId}
          onChange={(event) => setPartId(event.target.value)}
        >
          <option value="">选择配件</option>
          {parts.map((part) => (
            <option key={part.id} value={part.id}>
              {part.name} · {part.spec}
            </option>
          ))}
        </select>
      </Field>
      <div className="flow-form__row">
        <Field label="采购数量" htmlFor="flow-purchase-qty" required>
          <input
            id="flow-purchase-qty"
            className="input mono"
            inputMode="numeric"
            value={quantity}
            onChange={(event) => setQuantity(event.target.value)}
          />
        </Field>
        <Field label="采购单价" htmlFor="flow-purchase-price" required hint="元 / 件，两位小数">
          <input
            id="flow-purchase-price"
            className="input mono"
            inputMode="decimal"
            placeholder="0.00"
            value={unitPrice}
            onChange={(event) => setUnitPrice(event.target.value)}
          />
        </Field>
      </div>
      <p className="flow-form__meta">
        电镀为 F 项，本项目未启用：采购项不记录镀层，利润也不计镀层成本。
      </p>
      <Button
        loading={ctx.pending === 'create-purchase'}
        disabled={!ready}
        trailing={<ArrowRight size={15} />}
        onClick={() =>
          ctx.run('create-purchase', `/orders/${ctx.order.id}/purchase`, {
            supplierId,
            partId,
            quantity: qty,
            unitPrice: unitPrice.trim(),
          })
        }
      >
        创建采购单
      </Button>
    </div>
  );
}

/* ---------- 到货 ---------- */
function ArrivalForm({ ctx }: { ctx: Ctx }) {
  const purchase = ctx.order.flow.purchase;
  const item = purchase?.items[0];
  const remaining = item ? item.quantity - item.arrivedQty : 0;
  const [quantity, setQuantity] = useState(String(Math.max(remaining, 1)));
  const qty = toInt(quantity);

  if (!purchase || !item) return null;

  return (
    <div className="flow-form">
      <p className="flow-form__lead">
        {purchase.supplierName} · {item.partName} {item.partSpec}
      </p>
      <p className="flow-form__meta mono">
        已到 {item.arrivedQty} / {item.quantity} · 剩余 {remaining}
      </p>
      <Field label="本次到货数量" htmlFor="flow-arrival-qty" required hint="不得超过采购剩余量">
        <input
          id="flow-arrival-qty"
          className="input mono"
          inputMode="numeric"
          value={quantity}
          onChange={(event) => setQuantity(event.target.value)}
        />
      </Field>
      <Button
        loading={ctx.pending === 'record-arrival'}
        disabled={qty === null || qty > remaining}
        trailing={<ArrowRight size={15} />}
        onClick={() =>
          ctx.run('record-arrival', `/purchases/${purchase.id}/arrivals`, { quantity: qty })
        }
      >
        登记到货
      </Button>
    </div>
  );
}

/* ---------- 生产下发 ---------- */
function ProductionDispatchForm({ ctx }: { ctx: Ctx }) {
  const departments = useStock<Department>('/departments');
  const productionDepartments = departments.filter(
    (department) => department.category === 'PRODUCTION',
  );
  const [departmentId, setDepartmentId] = useState('');
  const [processName, setProcessName] = useState('');
  const [quantity, setQuantity] = useState(String(ctx.order.flow.quantities.orderQty || 1));
  const [unitPrice, setUnitPrice] = useState('');
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!departmentId && productionDepartments[0]) {
      setDepartmentId(productionDepartments[0].id);
    }
  }, [departmentId, productionDepartments]);

  const qty = toInt(quantity);
  const priceOk = /^(0|[1-9]\d{0,9})(\.\d{1,2})?$/.test(unitPrice.trim());
  const ready = departmentId !== '' && processName.trim() !== '' && qty !== null && priceOk;

  return (
    <div className="flow-form">
      <p className="flow-form__lead">采购已全部到货，选择生产部门与工艺下发任务。</p>
      <Field label="生产部门" htmlFor="flow-department" required>
        <select
          id="flow-department"
          className="select"
          value={departmentId}
          onChange={(event) => setDepartmentId(event.target.value)}
        >
          {productionDepartments.map((department) => (
            <option key={department.id} value={department.id}>
              {department.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="工艺" htmlFor="flow-process" required>
        <input
          id="flow-process"
          className="input"
          placeholder="例如 机加工 / 装配"
          value={processName}
          onChange={(event) => setProcessName(event.target.value)}
        />
      </Field>
      <div className="flow-form__row">
        <Field label="任务数量" htmlFor="flow-production-qty" required>
          <input
            id="flow-production-qty"
            className="input mono"
            inputMode="numeric"
            value={quantity}
            onChange={(event) => setQuantity(event.target.value)}
          />
        </Field>
        <Field label="加工单价" htmlFor="flow-production-price" required hint="元 / 件">
          <input
            id="flow-production-price"
            className="input mono"
            inputMode="decimal"
            placeholder="0.00"
            value={unitPrice}
            onChange={(event) => setUnitPrice(event.target.value)}
          />
        </Field>
      </div>
      <label className="toggle">
        <input
          type="checkbox"
          checked={visible}
          onChange={(event) => setVisible(event.target.checked)}
        />
        <span className="toggle__track" aria-hidden>
          <span className="toggle__thumb" />
        </span>
        <span className="toggle__text">允许生产人员看到本任务加工单价</span>
      </label>
      <Button
        loading={ctx.pending === 'dispatch-production'}
        disabled={!ready}
        trailing={<ArrowRight size={15} />}
        onClick={() =>
          ctx.run('dispatch-production', `/orders/${ctx.order.id}/productions`, {
            departmentId,
            processName: processName.trim(),
            quantity: qty,
            unitPrice: unitPrice.trim(),
            unitPriceVisible: visible,
          })
        }
      >
        下发生产
      </Button>
    </div>
  );
}

/* ---------- 生产反馈 ---------- */
function FeedbackForm({ ctx }: { ctx: Ctx }) {
  const production = ctx.order.flow.production;
  const [quantity, setQuantity] = useState(String(production?.quantity ?? 1));
  const qty = toInt(quantity);
  if (!production) return null;

  return (
    <div className="flow-form">
      <p className="flow-form__lead">
        {production.departmentName} · {production.processName}
      </p>
      <p className="flow-form__meta mono">任务数量 {production.quantity}</p>
      {production.unitPriceForWorker ? (
        <p className="flow-form__meta mono">本任务加工单价 ¥{production.unitPriceForWorker}</p>
      ) : null}
      <Field label="本次完成数量" htmlFor="flow-feedback-qty" required hint="不得超过任务数量">
        <input
          id="flow-feedback-qty"
          className="input mono"
          inputMode="numeric"
          value={quantity}
          onChange={(event) => setQuantity(event.target.value)}
        />
      </Field>
      <Button
        loading={ctx.pending === 'production-feedback'}
        disabled={qty === null || qty > production.quantity}
        trailing={<ArrowRight size={15} />}
        onClick={() =>
          ctx.run('production-feedback', `/productions/${production.id}/feedback`, { quantity: qty })
        }
      >
        提交反馈
      </Button>
    </div>
  );
}

/* ---------- 质检录入 ---------- */
function QcEntryForm({ ctx }: { ctx: Ctx }) {
  const production = ctx.order.flow.production;
  const produced = ctx.order.flow.quantities.producedQty;
  const [quantity, setQuantity] = useState(String(produced || 1));
  const qty = toInt(quantity);
  if (!production) return null;

  return (
    <div className="flow-form">
      <p className="flow-form__lead">M 版本仅支持全合格质检：合格量自动等于检验量。</p>
      <p className="flow-form__meta mono">已生产 {produced}</p>
      <Field label="检验数量" htmlFor="flow-qc-qty" required hint="不得超过已生产数量">
        <input
          id="flow-qc-qty"
          className="input mono"
          inputMode="numeric"
          value={quantity}
          onChange={(event) => setQuantity(event.target.value)}
        />
      </Field>
      <Button
        loading={ctx.pending === 'qc-entry'}
        disabled={qty === null || qty > produced}
        trailing={<ArrowRight size={15} />}
        onClick={() =>
          ctx.run('qc-entry', `/productions/${production.id}/qc-records`, {
            inspectedQty: qty,
            qualifiedQty: qty,
            unqualifiedQty: 0,
          })
        }
      >
        提交全合格结果
      </Button>
    </div>
  );
}

/* ---------- 质检放行 ---------- */
function QcDecisionForm({ ctx }: { ctx: Ctx }) {
  const qc = ctx.order.flow.qc;
  if (!qc) return null;
  return (
    <div className="flow-form">
      <p className="flow-form__lead">
        品控录入：检验 {qc.inspectedQty} · 合格 {qc.qualifiedQty} · 不合格 {qc.unqualifiedQty}
      </p>
      <p className="flow-form__meta">放行后该数量才可供包装使用。返工与报废为 F 未实现。</p>
      <Button
        loading={ctx.pending === 'qc-decision'}
        trailing={<CheckIcon size={15} />}
        onClick={() => ctx.run('qc-decision', `/qc-records/${qc.id}/decision`, { decision: 'PASS' })}
      >
        确认放行
      </Button>
    </div>
  );
}

/* ---------- 包装 / 发货 ---------- */
function QuantityForm({
  ctx,
  action,
  path,
  max,
  label,
  hint,
  suffix,
}: {
  ctx: Ctx;
  action: OrderAction;
  path: string;
  max: number;
  label: string;
  hint: string;
  suffix: string;
}) {
  const [quantity, setQuantity] = useState(String(Math.max(max, 1)));
  const qty = toInt(quantity);
  return (
    <div className="flow-form">
      <p className="flow-form__meta mono">{suffix}</p>
      <Field label={label} htmlFor={`flow-${action}-qty`} required hint={hint}>
        <input
          id={`flow-${action}-qty`}
          className="input mono"
          inputMode="numeric"
          value={quantity}
          onChange={(event) => setQuantity(event.target.value)}
        />
      </Field>
      <Button
        loading={ctx.pending === action}
        disabled={qty === null || qty > max}
        trailing={<ArrowRight size={15} />}
        onClick={() => ctx.run(action, path, { quantity: qty })}
      >
        {ACTION_LABEL[action]}
      </Button>
    </div>
  );
}

function ConfirmForm({
  ctx,
  action,
  path,
  text,
}: {
  ctx: Ctx;
  action: OrderAction;
  path: string;
  text: string;
}) {
  return (
    <div className="flow-form">
      <p className="flow-form__lead">{text}</p>
      <Button
        loading={ctx.pending === action}
        trailing={<ArrowRight size={15} />}
        onClick={() => ctx.run(action, path, {})}
      >
        {ACTION_LABEL[action]}
      </Button>
    </div>
  );
}

function renderAction(action: OrderAction, ctx: Ctx, key: string) {
  const q = ctx.order.flow.quantities;
  const orderId = ctx.order.id;
  switch (action) {
    case 'create-purchase':
      return <PurchaseForm key={key} ctx={ctx} />;
    case 'record-arrival':
      return <ArrivalForm key={key} ctx={ctx} />;
    case 'dispatch-production':
      return <ProductionDispatchForm key={key} ctx={ctx} />;
    case 'production-feedback':
      return <FeedbackForm key={key} ctx={ctx} />;
    case 'qc-entry':
      return <QcEntryForm key={key} ctx={ctx} />;
    case 'qc-decision':
      return <QcDecisionForm key={key} ctx={ctx} />;
    case 'dispatch-qc':
      return (
        <ConfirmForm
          key={key}
          ctx={ctx}
          action="dispatch-qc"
          path={`/orders/${orderId}/qc-dispatch`}
          text={`已生产 ${q.producedQty} 件，下发质检后由品控录入结果。`}
        />
      );
    case 'dispatch-packing':
      return (
        <ConfirmForm
          key={key}
          ctx={ctx}
          action="dispatch-packing"
          path={`/orders/${orderId}/packing-dispatch`}
          text={`已放行 ${q.releasedQty} 件，下发包装后由包装人员登记。`}
        />
      );
    case 'record-packing':
      return (
        <QuantityForm
          key={key}
          ctx={ctx}
          action="record-packing"
          path={`/orders/${orderId}/packing-records`}
          max={q.packableRemaining}
          label="本次包装数量"
          hint="不得超过可包装剩余"
          suffix={`放行 ${q.releasedQty} · 已包装 ${q.packedQty} · 可包装剩余 ${q.packableRemaining}`}
        />
      );
    case 'trigger-shipping':
      return (
        <ConfirmForm
          key={key}
          ctx={ctx}
          action="trigger-shipping"
          path={`/orders/${orderId}/shipping-trigger`}
          text={`已包装 ${q.packedQty} 件，触发发货后由物流登记。`}
        />
      );
    case 'record-shipment':
      return (
        <QuantityForm
          key={key}
          ctx={ctx}
          action="record-shipment"
          path={`/orders/${orderId}/shipment-records`}
          max={Math.min(q.shippableRemaining, q.dueRemaining)}
          label="本次发货数量"
          hint="不超过可发货剩余与应交剩余中的较小值"
          suffix={`已包装 ${q.packedQty} · 已发货 ${q.shippedQty} · 应交剩余 ${q.dueRemaining}`}
        />
      );
    default:
      return null;
  }
}

export function FlowPanel({ order, onUpdated }: PanelProps) {
  const [pending, setPending] = useState<OrderAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const keyRef = useRef<{ action: OrderAction; key: string } | null>(null);

  const actions = order.allowedActions.filter(
    (action): action is OrderAction => action !== 'view',
  );

  const run = async (action: OrderAction, path: string, body: unknown) => {
    setPending(action);
    setError(null);
    if (!keyRef.current || keyRef.current.action !== action) {
      keyRef.current = { action, key: crypto.randomUUID() };
    }
    try {
      const next = await apiPost<OrderDetail>(path, body, {
        'Idempotency-Key': keyRef.current.key,
      });
      keyRef.current = null;
      onUpdated(next);
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'NETWORK_ERROR') {
        setError('网络中断，写入结果未知。可直接重试：本次沿用同一幂等键，不会重复写入。');
      } else if (caught instanceof ApiError) {
        setError(caught.message);
      } else {
        setError('操作失败，请稍后重试');
      }
    } finally {
      setPending(null);
    }
  };

  const ctx: Ctx = { order, pending, run };

  if (actions.length === 0) return null;

  return (
    <div className="bezelt">
      <div className="detail-card detail-card--tight">
        <p className="eyebrow">流转操作</p>
        {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}
        {actions.map((action) => renderAction(action, ctx, `${action}-${order.updatedAt}`))}
      </div>
    </div>
  );
}

/* ---------- 流转台账 ---------- */
export function FlowLedger({ order }: { order: OrderDetail }) {
  const { purchase, production, qc, packing, shipping, quantities, profit } = order.flow;
  const rows: Array<{ label: string; value: string; note?: string }> = [];

  if (purchase?.items[0]) {
    const item = purchase.items[0];
    rows.push({
      label: '采购',
      value: `${item.partName} × ${item.quantity}`,
      note: `${purchase.supplierName} · 已到 ${item.arrivedQty}`,
    });
  }
  if (production) {
    rows.push({
      label: '生产',
      value: `${production.processName} × ${production.quantity}`,
      note: `${production.departmentName} · 已完成 ${production.completedQty}`,
    });
  }
  if (qc) {
    rows.push({
      label: '质检',
      value: `检验 ${qc.inspectedQty} · 合格 ${qc.qualifiedQty}`,
      note: qc.decision
        ? `${qc.decision.decision} 放行 ${qc.decision.releasedQty}`
        : '等待管理员放行',
    });
  }
  if (packing.records.length > 0) {
    rows.push({
      label: '包装',
      value: `${quantities.packedQty} 件`,
      note: `${packing.records.length} 次登记`,
    });
  }
  if (shipping.records.length > 0) {
    rows.push({
      label: '发货',
      value: `${quantities.shippedQty} / ${quantities.orderQty}`,
      note: `应交剩余 ${quantities.dueRemaining}`,
    });
  }

  if (rows.length === 0) return null;

  return (
    <section className="bezelt">
      <div className="detail-card">
        <div className="detail-card__head">
          <h2>流转台账</h2>
          <span className="detail-card__note mono">FLOW</span>
        </div>
        <ul className="ledger">
          {rows.map((row) => (
            <li className="ledger__row" key={row.label}>
              <span className="ledger__label">{row.label}</span>
              <span className="ledger__value">{row.value}</span>
              <span className="ledger__note">{row.note}</span>
            </li>
          ))}
        </ul>
        {profit ? (
          <div className="profit">
            <div className="profit__item">
              <span>销售额</span>
              <strong className="mono">{formatMoney(profit.sales)}</strong>
            </div>
            <div className="profit__item">
              <span>采购成本</span>
              <strong className="mono">{formatMoney(profit.purchaseCost)}</strong>
            </div>
            <div className="profit__item">
              <span>生产成本</span>
              <strong className="mono">{formatMoney(profit.productionCost)}</strong>
            </div>
            <div className="profit__item profit__item--total">
              <span>预计利润</span>
              <strong className="mono">{formatMoney(profit.profit)}</strong>
              <small>毛利率 {profit.marginPercent}%</small>
            </div>
          </div>
        ) : null}
        <p className="detail-card__lock">
          预计利润按订单快照与有效业务记录计算，不代表客户已付款或工厂已结清费用。
        </p>
      </div>
    </section>
  );
}