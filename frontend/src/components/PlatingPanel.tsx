import { useEffect, useRef, useState } from 'react';
import { ApiError, apiDelete, apiGet, apiGetPage, apiPatch, apiPost } from '../api/client';
import type { OrderDetail, PlatingOrderFlow, Supplier } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { formatDateTime, formatMoney } from '../lib/format';
import { Button, Field, InlineNotice } from './ui';

const STATUS_LABEL: Record<PlatingOrderFlow['status'], string> = {
  PENDING: '待发送',
  SENT: '已发送',
  RECEIVED: '已收货',
};

/**
 * R06F：电镀外协卡片。
 * 管理员建单/改单/删除；物流发送与收货；电镀收货前不能下发生产。
 */
export function PlatingPanel({
  order,
  onUpdated,
}: {
  order: OrderDetail;
  onUpdated: (detail: OrderDetail) => void;
}) {
  const { user } = useAuth();
  const plating = order.flow.plating;
  const purchase = order.flow.purchase;
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [purchaseItemId, setPurchaseItemId] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const [quantity, setQuantity] = useState('');
  const [unitPrice, setUnitPrice] = useState('');
  const [editing, setEditing] = useState<PlatingOrderFlow | null>(null);
  const [editQty, setEditQty] = useState('');
  const [editPrice, setEditPrice] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * 同一意图重试必须复用同一个幂等键；请求体变了才算新意图。
   * 成功后清空，下一次操作重新生成。
   */
  const keysRef = useRef<Record<string, string>>({});
  const keyFor = (tag: string) => {
    if (!keysRef.current[tag]) keysRef.current[tag] = crypto.randomUUID();
    return keysRef.current[tag];
  };

  useEffect(() => {
    if (user?.role !== 'ADMIN') return;
    let cancelled = false;
    apiGetPage<Supplier[]>('/suppliers?active=true&type=ELECTROPLATING&pageSize=200')
      .then((result) => {
        if (!cancelled) setSuppliers(result.data);
      })
      .catch(() => {
        if (!cancelled) setSuppliers([]);
      });
    return () => {
      cancelled = true;
    };
  }, [user?.role]);

  if (!purchase || !plating) return null;

  const requiredItems = purchase.items.filter((item) => item.platingRequired);
  const selectedItem =
    purchase.items.find((item) => item.id === purchaseItemId) ?? requiredItems[0] ?? null;
  const remaining = selectedItem
    ? Math.max(0, selectedItem.arrivedQty - selectedItem.platingQty)
    : 0;

  const refresh = async () => {
    const detail = await apiGet<OrderDetail>(`/orders/${order.id}`);
    onUpdated(detail);
  };

  const act = async (fn: () => Promise<unknown>, _success?: string) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      keysRef.current = {};
      await refresh();
      setEditing(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '操作失败，请稍后重试');
    } finally {
      setBusy(false);
    }
  };

  if (plating.notApplicable) {
    return (
      <section className="panel panel--pad plating-panel">
        <div className="panel__head">
          <div>
            <h2 className="panel__title">电镀</h2>
            <p className="panel__meta">该订单不需要电镀，本环节不适用，也不会生成电镀事件。</p>
          </div>
        </div>
      </section>
    );
  }

  const canCreate =
    user?.role === 'ADMIN' && order.status === 'PURCHASING' && !!selectedItem && remaining > 0;
  const isLogistics = user?.role === 'LOGISTICS';

  return (
    <section className="panel panel--pad plating-panel" aria-busy={busy}>
      <div className="panel__head">
        <div>
          <h2 className="panel__title">电镀外协</h2>
          <p className="panel__meta">
            需电镀 {order.flow.quantities.platingRequiredQty} 件 · 已发{' '}
            {plating.sentQty} · 已收 {plating.receivedQty} · 待收 {plating.outstandingQty}
          </p>
        </div>
      </div>

      {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}

      {plating.orders.length === 0 ? (
        <p className="detail-card__empty">还没有电镀单。管理员先建单，再由物流发送和收货。</p>
      ) : (
        <ul className="attach-list">
          {plating.orders.map((row) => (
            <li key={row.id} className="attach-item plating-item">
              <span className="attach-item__name">
                <span className="attach-item__title">
                  {row.partName} × {row.quantity}
                  <span className={`badge badge--device-${row.status.toLowerCase()}`}>
                    {STATUS_LABEL[row.status]}
                  </span>
                </span>
                <span className="attach-item__meta mono">
                  {row.supplierName}
                  {row.unitPrice ? ` · ${formatMoney(row.unitPrice)}/件` : ''}
                  {row.sentAt ? ` · 发出 ${formatDateTime(row.sentAt)}` : ''}
                  {row.receivedAt ? ` · 收回 ${formatDateTime(row.receivedAt)}` : ''}
                </span>
              </span>

              <span className="exception-dispose__actions">
                {user?.role === 'ADMIN' && row.status === 'PENDING' ? (
                  editing?.id === row.id ? (
                    <>
                      <input
                        className="input input--tiny mono"
                        inputMode="numeric"
                        value={editQty}
                        onChange={(event) => setEditQty(event.target.value)}
                        aria-label="电镀数量"
                      />
                      <input
                        className="input input--tiny mono"
                        inputMode="decimal"
                        value={editPrice}
                        onChange={(event) => setEditPrice(event.target.value)}
                        aria-label="电镀单价"
                      />
                      <button
                        type="button"
                        className="text-btn"
                        disabled={busy}
                        onClick={() =>
                          void act(
                            () =>
                              apiPatch(
                                `/plating-orders/${row.id}`,
                                {
                                  quantity: Number(editQty),
                                  unitPrice: editPrice.trim(),
                                },
                                {
                                  'Idempotency-Key': keyFor(
                                    `edit:${row.id}:${editQty}:${editPrice}`,
                                  ),
                                },
                              ),
                            '电镀单已更新',
                          )
                        }
                      >
                        保存
                      </button>
                      <button type="button" className="text-btn" onClick={() => setEditing(null)}>
                        取消
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="text-btn"
                        onClick={() => {
                          setEditing(row);
                          setEditQty(String(row.quantity));
                          setEditPrice(row.unitPrice ?? '');
                        }}
                      >
                        修改
                      </button>
                      <button
                        type="button"
                        className="text-btn text-btn--danger"
                        disabled={busy}
                        onClick={() => void act(() => apiDelete(`/plating-orders/${row.id}`), '电镀单已删除')}
                      >
                        删除
                      </button>
                    </>
                  )
                ) : null}

                {isLogistics && row.status === 'PENDING' ? (
                  <button
                    type="button"
                    className="text-btn"
                    disabled={busy}
                    onClick={() =>
                      void act(
                        () =>
                          apiPost(`/plating-orders/${row.id}/send`, undefined, {
                            'Idempotency-Key': keyFor(`send:${row.id}`),
                          }),
                        '已登记发送',
                      )
                    }
                  >
                    发送
                  </button>
                ) : null}
                {isLogistics && row.status === 'SENT' ? (
                  <button
                    type="button"
                    className="text-btn"
                    disabled={busy}
                    onClick={() =>
                      void act(
                        () =>
                          apiPost(`/plating-orders/${row.id}/receive`, undefined, {
                            'Idempotency-Key': keyFor(`receive:${row.id}`),
                          }),
                        '已登记收货',
                      )
                    }
                  >
                    收货
                  </button>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}

      {user?.role === 'ADMIN' && order.status === 'PURCHASING' && remaining === 0 ? (
        <p className="field__error">
          该采购项尚未到货或已全部电镀，当前可电镀余量为 0。请先让物流登记到货，再建电镀单。
        </p>
      ) : null}

      {canCreate ? (
        <div className="plating-create">
          <Field label="采购项" htmlFor="plating-item" required>
            <select
              id="plating-item"
              className="input input--select"
              value={selectedItem?.id ?? ''}
              onChange={(event) => setPurchaseItemId(event.target.value)}
            >
              {requiredItems.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.partName} · {item.partSpec}（已到 {item.arrivedQty}）
                </option>
              ))}
            </select>
          </Field>
          <Field label="电镀厂商" htmlFor="plating-supplier" required>
            <select
              id="plating-supplier"
              className="input input--select"
              value={supplierId}
              onChange={(event) => setSupplierId(event.target.value)}
            >
              <option value="">选择电镀厂商</option>
              {suppliers.map((supplier) => (
                <option key={supplier.id} value={supplier.id}>
                  {supplier.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="电镀数量" htmlFor="plating-qty" required hint={`可电镀余量 ${remaining}`}>
            <input
              id="plating-qty"
              className="input mono"
              inputMode="numeric"
              value={quantity}
              onChange={(event) => setQuantity(event.target.value)}
              placeholder={String(remaining || 1)}
            />
          </Field>
          <Field label="单价" htmlFor="plating-price" required hint="元 / 件">
            <input
              id="plating-price"
              className="input mono"
              inputMode="decimal"
              value={unitPrice}
              onChange={(event) => setUnitPrice(event.target.value)}
              placeholder="如 2.50"
            />
          </Field>
          <Button
            loading={busy}
            disabled={!selectedItem || !supplierId || !quantity || !unitPrice}
            onClick={() =>
              void act(
                () =>
                  apiPost(
                    `/orders/${order.id}/plating-orders`,
                    {
                      purchaseItemId: selectedItem?.id,
                      supplierId,
                      quantity: Number(quantity),
                      unitPrice: unitPrice.trim(),
                    },
                    {
                      'Idempotency-Key': keyFor(
                        `create:${selectedItem?.id}:${supplierId}:${quantity}:${unitPrice}`,
                      ),
                    },
                  ),
                '电镀单已创建',
              )
            }
          >
            创建电镀单
          </Button>
        </div>
      ) : null}

      {order.status !== 'PURCHASING' && plating.outstandingQty > 0 ? (
        <p className="field__error">
          生产已开始，剩余 {plating.outstandingQty} 件未电镀；单生产任务模式下无法继续补产（R07F 边界）。
        </p>
      ) : null}
    </section>
  );
}