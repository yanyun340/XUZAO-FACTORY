import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ApiError, apiDelete, apiGet, apiGetPage, apiPatch, apiPost } from '../api/client';
import type { Part, PartSupplier, Supplier } from '../api/types';
import { useModalFocus } from '../hooks/useModalFocus';
import { SUPPLIER_TYPE_LABEL } from '../lib/format';
import { Button, InlineNotice } from './ui';

export function PartSuppliersDialog({
  part,
  onClose,
}: {
  part: Part;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<PartSupplier[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [supplierId, setSupplierId] = useState('');
  const [makeDefault, setMakeDefault] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cardRef = useModalFocus(true, onClose, { canClose: () => !busy });

  const load = useCallback(async () => {
    try {
      const [list, all] = await Promise.all([
        apiGet<PartSupplier[]>(`/parts/${part.id}/suppliers`),
        apiGetPage<Supplier[]>('/suppliers?pageSize=200&active=true'),
      ]);
      setRows(list);
      setSuppliers(all.data);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '供应商列表加载失败');
    }
  }, [part.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const add = async () => {
    if (!supplierId) return;
    setBusy(true);
    setError(null);
    try {
      await apiPost(`/parts/${part.id}/suppliers`, { supplierId, isDefault: makeDefault });
      setSupplierId('');
      setMakeDefault(false);
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '添加失败');
    } finally {
      setBusy(false);
    }
  };

  const setDefault = async (row: PartSupplier) => {
    setBusy(true);
    setError(null);
    try {
      await apiPatch(`/parts/${part.id}/suppliers/${row.supplierId}`, { isDefault: true });
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '设置默认供应商失败');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (row: PartSupplier) => {
    if (!window.confirm(`移除供应商「${row.supplierName}」与配件的关联？`)) return;
    setBusy(true);
    setError(null);
    try {
      await apiDelete(`/parts/${part.id}/suppliers/${row.supplierId}`);
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '移除失败');
    } finally {
      setBusy(false);
    }
  };

  const available = suppliers.filter(
    (supplier) => !rows.some((row) => row.supplierId === supplier.id),
  );

  return createPortal(
    <div className="modal" role="dialog" aria-modal="true" aria-label="配件供应商">
      <button type="button" className="modal__backdrop" aria-label="关闭" onClick={onClose} />
      <form
        ref={cardRef}
        className="modal__card modal__card--wide"
        onSubmit={(event) => event.preventDefault()}
      >
        <p className="eyebrow">SUPPLIER SET</p>
        <h2 className="modal__title">配件供应商 · {part.name}</h2>
        <p className="modal__sub">
          配置后，采购只能从集合里选供应商；同一配件至多一个默认供应商。
        </p>

        {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}

        {rows.length === 0 ? (
          <p className="detail-card__empty">还没有配置供应商，采购时仍可选任意有效供应商。</p>
        ) : (
          <ul className="attach-list">
            {rows.map((row) => (
              <li key={row.id} className="attach-item">
                <span className="attach-item__name">
                  <span className="attach-item__title">
                    {row.supplierName}
                    {row.isDefault ? <span className="badge badge--default">默认</span> : null}
                  </span>
                  <span className="attach-item__meta mono">
                    {row.supplierCode} · {SUPPLIER_TYPE_LABEL[row.supplierType] ?? row.supplierType}
                    {row.supplierActive ? '' : ' · 已停用'}
                  </span>
                </span>
                <span className="exception-dispose__actions">
                  {!row.isDefault ? (
                    <button
                      type="button"
                      className="text-btn"
                      disabled={busy}
                      onClick={() => void setDefault(row)}
                    >
                      设为默认
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="text-btn"
                    disabled={busy}
                    onClick={() => void remove(row)}
                  >
                    移除
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}

        <div className="exception-dispose">
          <label className="field">
            <span className="field__label">添加供应商</span>
            <select
              className="input input--select"
              value={supplierId}
              onChange={(event) => setSupplierId(event.target.value)}
            >
              <option value="">选择供应商</option>
              {available.map((supplier) => (
                <option key={supplier.id} value={supplier.id}>
                  {supplier.name}（{SUPPLIER_TYPE_LABEL[supplier.type] ?? supplier.type}）
                </option>
              ))}
            </select>
          </label>
          <label className="check-field">
            <input
              type="checkbox"
              checked={makeDefault}
              onChange={(event) => setMakeDefault(event.target.checked)}
            />
            <span>设为默认</span>
          </label>
          <Button type="button" loading={busy} disabled={!supplierId} onClick={() => void add()}>
            添加
          </Button>
        </div>

        <div className="modal__actions">
          <button type="button" className="text-btn" onClick={onClose}>
            关闭
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}