import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { ApiError, apiGetPage, apiPost } from '../api/client';
import type { InventoryLogItem, PageMeta, PartStock, ProductStock } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { PlusIcon, SearchIcon } from '../components/Icons';
import { DataTable } from '../components/DataTable';
import { announce } from '../components/LiveAnnouncer';
import { Pagination } from '../components/Pagination';
import { Button, EmptyState, InlineNotice, LoadingBlock } from '../components/ui';
import { useModalFocus } from '../hooks/useModalFocus';
import { formatDateTime, formatNumber } from '../lib/format';

type Tab = 'parts' | 'products' | 'logs';

const PAGE_SIZE = 15;

interface AdjustState {
  kind: 'part' | 'product';
  id: string;
  label: string;
  current: number;
}

export function InventoryPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';

  const [tab, setTab] = useState<Tab>('parts');
  const [keyword, setKeyword] = useState('');
  const [queryInput, setQueryInput] = useState('');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const [parts, setParts] = useState<PartStock[]>([]);
  const [products, setProducts] = useState<ProductStock[]>([]);
  const [logs, setLogs] = useState<InventoryLogItem[]>([]);
  const [meta, setMeta] = useState<PageMeta | null>(null);

  const [adjusting, setAdjusting] = useState<AdjustState | null>(null);
  const [delta, setDelta] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [adjustError, setAdjustError] = useState<string | null>(null);
  // R25F：同一次调整意图沿用同一把幂等键，网络失败后重试不会重复扣减。
  const adjustKeyRef = useRef('');
  const createKeyRef = useRef('');

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newSpec, setNewSpec] = useState('');
  const [newQty, setNewQty] = useState('0');

  const cardRef = useModalFocus(adjusting !== null, () => setAdjusting(null), {
    canClose: () => !busy,
  });

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
    if (keyword) params.set('keyword', keyword);

    const path =
      tab === 'logs' ? `/inventory/logs?${params.toString()}` : `/inventory/${tab}?${params.toString()}`;

    apiGetPage<unknown[]>(path)
      .then((result) => {
        if (cancelled) return;
        setMeta(result.meta);
        if (tab === 'parts') setParts(result.data as PartStock[]);
        else if (tab === 'products') setProducts(result.data as ProductStock[]);
        else setLogs(result.data as InventoryLogItem[]);
      })
      .catch((caught) => {
        if (cancelled) return;
        setError(caught instanceof ApiError ? caught.message : '库存加载失败，请稍后重试');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [tab, page, keyword, reloadToken]);

  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    setPage(1);
    setKeyword(queryInput.trim());
  };

  const openAdjust = (state: AdjustState) => {
    setAdjusting(state);
    setDelta('');
    setReason('');
    setAdjustError(null);
    adjustKeyRef.current = crypto.randomUUID();
  };

  const submitAdjust = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      if (!adjusting) return;

      const amount = Number(delta);
      if (!Number.isInteger(amount) || amount === 0) {
        setAdjustError('请输入非 0 的整数，负数表示出库');
        return;
      }
      if (reason.trim().length < 2) {
        setAdjustError('请填写至少 2 个字的调整原因');
        return;
      }

      setBusy(true);
      setAdjustError(null);
      try {
        await apiPost(
          `/inventory/${adjusting.kind === 'part' ? 'parts' : 'products'}/${adjusting.id}/adjust`,
          { delta: amount, reason: reason.trim() },
          { 'Idempotency-Key': adjustKeyRef.current },
        );
        adjustKeyRef.current = '';
        setAdjusting(null);
        announce(`库存已调整 ${amount > 0 ? '+' : ''}${amount}`);
        setReloadToken((token) => token + 1);
      } catch (caught) {
        setAdjustError(caught instanceof ApiError ? caught.message : '库存调整失败，请稍后重试');
      } finally {
        setBusy(false);
      }
    },
    [adjusting, delta, reason],
  );

  const submitCreate = async (event: FormEvent) => {
    event.preventDefault();
    if (!newName.trim() || !newSpec.trim()) {
      setError('产品名称和规格都不能为空');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await apiPost(
        '/inventory/products',
        {
          productName: newName.trim(),
          spec: newSpec.trim(),
          quantity: Number(newQty) || 0,
          reason: '新建商品档案',
        },
        { 'Idempotency-Key': createKeyRef.current },
      );
      createKeyRef.current = '';
      setCreating(false);
      setNewName('');
      setNewSpec('');
      setNewQty('0');
      setReloadToken((token) => token + 1);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '新建商品失败');
    } finally {
      setBusy(false);
    }
  };

  const switchTab = (next: Tab) => {
    setTab(next);
    setPage(1);
    setKeyword('');
    setQueryInput('');
    setAdjusting(null);
  };

  return (
    <div className="page">
      <header className="page-head">
        <div className="page-head__copy">
          <p className="eyebrow">STOCK / 库存台账</p>
          <h1 className="page-title">库存</h1>
          <p className="page-lede">
            配件与商品库存、手工调整与完整流水。调整带原因、带操作人，并且不允许扣成负数。
          </p>
        </div>
        {isAdmin && tab === 'products' ? (
          <div className="page-head__action">
            <Button
              onClick={() => {
                setCreating((value) => {
                  if (!value) createKeyRef.current = crypto.randomUUID();
                  return !value;
                });
              }}
              trailing={<PlusIcon size={16} />}
            >
              新增商品
            </Button>
          </div>
        ) : null}
      </header>

      <div className="segmented" role="tablist" aria-label="库存分类">
        {(
          [
            ['parts', '配件库存'],
            ['products', '商品库存'],
            ['logs', '出入库流水'],
          ] as Array<[Tab, string]>
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            className={`segmented__item${tab === value ? ' is-active' : ''}`}
            onClick={() => switchTab(value)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="filter-bar">
        <form className="search" onSubmit={submitSearch} role="search">
          <SearchIcon size={17} />
          <input
            className="search__input"
            type="search"
            value={queryInput}
            onChange={(event) => setQueryInput(event.target.value)}
            placeholder={tab === 'logs' ? '流水不支持搜索' : '搜索编码、名称或规格'}
            aria-label="搜索库存"
            disabled={tab === 'logs'}
          />
        </form>
        {meta ? <span className="panel__count">共 {formatNumber(meta.total)} 条</span> : null}
      </div>

      {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}

      {creating && tab === 'products' ? (
        <form className="panel panel--pad inline-form" onSubmit={(event) => void submitCreate(event)}>
          <div className="inline-form__grid">
            <label className="field">
              <span className="field__label">产品名称</span>
              <input
                className="input"
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
                maxLength={100}
                required
              />
            </label>
            <label className="field">
              <span className="field__label">规格</span>
              <input
                className="input"
                value={newSpec}
                onChange={(event) => setNewSpec(event.target.value)}
                maxLength={200}
                required
              />
            </label>
            <label className="field">
              <span className="field__label">初始库存</span>
              <input
                className="input"
                type="number"
                min={0}
                value={newQty}
                onChange={(event) => setNewQty(event.target.value)}
              />
            </label>
          </div>
          <div className="inline-form__actions">
            <Button type="submit" loading={busy}>
              保存
            </Button>
            <button type="button" className="text-btn" onClick={() => setCreating(false)}>
              取消
            </button>
          </div>
        </form>
      ) : null}

      <section className="panel" aria-busy={loading}>
        {loading ? (
          <LoadingBlock lines={6} />
        ) : tab === 'parts' ? (
          parts.length === 0 ? (
            <EmptyState title="没有匹配的配件库存" description="先在基础数据里创建配件，库存台账会自动生成。" />
          ) : (
            <DataTable
              label="配件库存"
              tableClassName="stock-table"
              headClassName="stock-table__head"
              rowClassName="stock-row"
              rowKey={(row) => row.id}
              rows={parts}
              columns={[
                {
                  key: 'name',
                  title: '配件',
                  className: 'stock-row__name',
                  cell: (row) => (
                    <>
                      <strong>{row.name}</strong>
                      <small className="mono">{row.code}</small>
                    </>
                  ),
                },
                {
                  key: 'spec',
                  title: '规格',
                  className: 'stock-row__spec',
                  cell: (row) => row.spec,
                },
                {
                  key: 'quantity',
                  title: '库存',
                  headClassName: 'stock-table__num',
                  className: (row) => `stock-row__num mono${row.quantity === 0 ? ' is-muted' : ''}`,
                  cell: (row) => formatNumber(row.quantity),
                },
                {
                  key: 'updatedAt',
                  title: '更新时间',
                  className: 'stock-row__time mono',
                  cell: (row) => formatDateTime(row.updatedAt),
                },
                {
                  key: 'action',
                  className: 'stock-row__action',
                  cell: (row) =>
                    isAdmin ? (
                      <button
                        type="button"
                        className="text-btn"
                        onClick={() =>
                          openAdjust({
                            kind: 'part',
                            id: row.id,
                            label: `${row.code} ${row.name} / ${row.spec}`,
                            current: row.quantity,
                          })
                        }
                      >
                        调整
                      </button>
                    ) : null,
                },
              ]}
            />
          )
        ) : tab === 'products' ? (
          products.length === 0 ? (
            <EmptyState
              title="还没有商品库存"
              description="创建订单后产品会自动登记；也可以由管理员手动建档。"
            />
          ) : (
            <DataTable
              label="商品库存"
              tableClassName="stock-table"
              headClassName="stock-table__head"
              rowClassName="stock-row"
              rowKey={(row) => row.id}
              rows={products}
              columns={[
                {
                  key: 'name',
                  title: '商品',
                  className: 'stock-row__name',
                  cell: (row) => <strong>{row.productName}</strong>,
                },
                {
                  key: 'spec',
                  title: '规格',
                  className: 'stock-row__spec',
                  cell: (row) => row.spec,
                },
                {
                  key: 'quantity',
                  title: '库存',
                  headClassName: 'stock-table__num',
                  className: (row) => `stock-row__num mono${row.quantity === 0 ? ' is-muted' : ''}`,
                  cell: (row) => formatNumber(row.quantity),
                },
                {
                  key: 'updatedAt',
                  title: '更新时间',
                  className: 'stock-row__time mono',
                  cell: (row) => formatDateTime(row.updatedAt),
                },
                {
                  key: 'action',
                  className: 'stock-row__action',
                  cell: (row) =>
                    isAdmin ? (
                      <button
                        type="button"
                        className="text-btn"
                        onClick={() =>
                          openAdjust({
                            kind: 'product',
                            id: row.id,
                            label: `${row.productName} / ${row.spec}`,
                            current: row.quantity,
                          })
                        }
                      >
                        调整
                      </button>
                    ) : null,
                },
              ]}
            />
          )
        ) : logs.length === 0 ? (
          <EmptyState title="还没有出入库记录" description="任何一次手工调整都会写一条流水。" />
        ) : (
          <DataTable
            label="出入库流水"
            tableClassName="log-table"
            rowClassName="log-row"
            rowKey={(row) => row.id}
            rows={logs}
            columns={[
              {
                key: 'kind',
                className: (row) => `log-row__kind log-row__kind--${row.kind.toLowerCase()}`,
                cell: (row) => (row.kind === 'PART' ? '配件' : '商品'),
              },
              {
                key: 'target',
                className: 'log-row__target',
                cell: (row) => row.target,
              },
              {
                key: 'delta',
                className: 'log-row__delta mono',
                cell: (row) => (
                  <>
                    {row.before} →{' '}
                    <strong className={row.delta > 0 ? 'is-up' : 'is-down'}>{row.after}</strong>
                    <small>
                      {row.delta > 0 ? '+' : ''}
                      {row.delta}
                    </small>
                  </>
                ),
              },
              {
                key: 'reason',
                className: 'log-row__reason',
                cell: (row) => row.reason,
              },
              {
                key: 'meta',
                className: 'log-row__meta mono',
                cell: (row) => (
                  <>
                    {row.operatorName} · {formatDateTime(row.createdAt)}
                  </>
                ),
              },
            ]}
          />
        )}

        <Pagination page={page} totalPages={meta?.totalPages ?? 1} onChange={setPage} />
      </section>

      {/* portal 到 body：.page 的入场 transform 会改变 fixed 的包含块，导致弹窗偏位 */}
      {adjusting
        ? createPortal(
            <div className="modal" role="dialog" aria-modal="true" aria-label="库存调整">
          <button
            type="button"
            className="modal__backdrop"
            aria-label="关闭"
            onClick={() => setAdjusting(null)}
          />
          <form ref={cardRef} className="modal__card" onSubmit={(event) => void submitAdjust(event)}>
            <p className="eyebrow">STOCK ADJUST</p>
            <h2 className="modal__title">调整库存</h2>
            <p className="modal__sub">{adjusting.label}</p>
            <p className="modal__current mono">
              当前数量 <strong>{formatNumber(adjusting.current)}</strong>
            </p>

            <label className="field">
              <span className="field__label">调整数量</span>
              <input
                className="input"
                type="number"
                step={1}
                value={delta}
                onChange={(event) => setDelta(event.target.value)}
                placeholder="正数入库，负数出库"
                data-autofocus
              />
            </label>

            <label className="field">
              <span className="field__label">调整原因</span>
              <input
                className="input"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                maxLength={200}
                placeholder="例如：月度盘点差异 / 供应商补货"
              />
            </label>

            {adjustError ? (
              <p className="field__error" role="alert">
                {adjustError}
              </p>
            ) : null}

            <div className="modal__actions">
              <Button type="submit" loading={busy}>
                确认调整
              </Button>
              <button type="button" className="text-btn" onClick={() => setAdjusting(null)}>
                取消
              </button>
            </div>
          </form>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}