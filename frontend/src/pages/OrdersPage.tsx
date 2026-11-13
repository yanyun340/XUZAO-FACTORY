import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, apiDownload, apiGetPage } from '../api/client';
import type { OrderStatus, OrderSummary, PageMeta } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import {
  ArrowRight,
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  PlusIcon,
  RefreshIcon,
  SearchIcon,
} from '../components/Icons';
import {
  Button,
  EmptyState,
  InlineNotice,
  LoadingBlock,
  SectionHeading,
  StageRibbon,
  StatusBadge,
} from '../components/ui';
import {
  STAGE_LABELS,
  STATUS_OPTIONS,
  dueHint,
  formatDateOnly,
  formatMoney,
  formatNumber,
  greeting,
} from '../lib/format';

const PAGE_SIZE = 12;

const STAGE_NAMES = Object.values(STAGE_LABELS);

export function OrdersPage() {
  const { user } = useAuth();
  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [meta, setMeta] = useState<PageMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [queryInput, setQueryInput] = useState('');
  const [keyword, setKeyword] = useState('');
  const [status, setStatus] = useState<OrderStatus | ''>('');
  const [page, setPage] = useState(1);
  const [reloadToken, setReloadToken] = useState(0);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
    if (status) params.set('status', status);
    if (keyword) params.set('keyword', keyword);

    apiGetPage<OrderSummary[]>(`/orders?${params.toString()}`)
      .then((result) => {
        if (cancelled) return;
        setOrders(result.data);
        setMeta(result.meta);
      })
      .catch((caught) => {
        if (cancelled) return;
        setError(caught instanceof ApiError ? caught.message : '订单加载失败，请稍后重试');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [page, status, keyword, reloadToken]);

  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    setPage(1);
    setKeyword(queryInput.trim());
  };

  const clearFilters = () => {
    setQueryInput('');
    setKeyword('');
    setStatus('');
    setPage(1);
  };

  const hasFilters = keyword.length > 0 || status !== '';
  const isAdmin = user?.role === 'ADMIN';

  // 导出沿用当前筛选条件，而不是导出「当前页」——避免分页误导
  const exportXlsx = async () => {
    setExporting(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (status) params.set('status', status);
      if (keyword) params.set('keyword', keyword);

      const { blob, fileName } = await apiDownload(`/orders/export.xlsx?${params.toString()}`);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = fileName;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '导出失败，请稍后重试');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="page">
      <SectionHeading
        eyebrow={`${greeting()}，${user?.displayName ?? ''} · ${new Date().getFullYear()}`}
        title="业务订单"
        description="所有角色的唯一订单视图。金额与客户联系方式按角色脱敏。"
        action={
          isAdmin ? (
            <Link className="btn btn--primary" to="/orders/new">
              <span className="btn__label">新建订单</span>
              <span className="btn__trailing">
                <PlusIcon size={16} />
              </span>
            </Link>
          ) : undefined
        }
      />

      <div className="filter-bar">
        <form className="search" onSubmit={submitSearch} role="search">
          <SearchIcon size={17} />
          <input
            className="search__input"
            type="search"
            value={queryInput}
            onChange={(event) => setQueryInput(event.target.value)}
            placeholder="搜索订单号、客户或产品"
            aria-label="搜索订单"
          />
          {queryInput ? (
            <button
              type="button"
              className="search__clear"
              onClick={() => {
                setQueryInput('');
                setKeyword('');
                setPage(1);
              }}
              aria-label="清除搜索"
            >
              ×
            </button>
          ) : null}
        </form>

        <div className="filter-bar__right">
          <label className="select-wrap">
            <span className="select-wrap__label">状态</span>
            <select
              className="select"
              value={status}
              onChange={(event) => {
                setStatus(event.target.value as OrderStatus | '');
                setPage(1);
              }}
            >
              <option value="">全部状态</option>
              {STATUS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          {hasFilters ? (
            <button type="button" className="text-btn" onClick={clearFilters}>
              清除筛选
            </button>
          ) : null}

          {isAdmin ? (
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              onClick={() => void exportXlsx()}
              disabled={exporting || orders.length === 0}
            >
              <span className="btn__label">{exporting ? '导出中…' : '导出 Excel'}</span>
            </button>
          ) : null}

          <button
            type="button"
            className="icon-btn"
            onClick={() => setReloadToken((token) => token + 1)}
            title="刷新"
            aria-label="刷新订单列表"
          >
            <RefreshIcon size={17} />
          </button>
        </div>
      </div>

      {error ? (
        <InlineNotice tone="error">
          <span>{error}</span>
          <button
            type="button"
            className="notice__retry"
            onClick={() => setReloadToken((token) => token + 1)}
          >
            重试
          </button>
        </InlineNotice>
      ) : null}

      <section className="panel" aria-live="polite" aria-busy={loading}>
        <div className="panel__head">
          <div>
            <h2 className="panel__title">订单列表</h2>
            <p className="panel__meta">
              {meta ? `共 ${formatNumber(meta.total)} 单` : '读取中'}
              {keyword ? ` · 匹配“${keyword}”` : ''}
            </p>
          </div>
          <span className="panel__count">
            {meta ? `第 ${meta.page} / ${meta.totalPages} 页` : ''}
          </span>
        </div>

        {loading ? (
          <LoadingBlock lines={5} />
        ) : orders.length === 0 ? (
          <EmptyState
            title={hasFilters ? '没有匹配的订单' : '还没有业务订单'}
            description={
              hasFilters
                ? '换一个关键词或状态试试，也可以清除筛选看全部订单。'
                : isAdmin
                  ? '从一张真实订单开始，后续采购、生产、质检、包装与发货都挂在它下面。'
                  : '管理员创建订单后，这里会出现完整列表。'
            }
            action={
              hasFilters ? (
                <Button variant="secondary" onClick={clearFilters}>
                  清除筛选
                </Button>
              ) : isAdmin ? (
                <Link className="btn btn--primary" to="/orders/new">
                  <span className="btn__label">创建第一张订单</span>
                  <span className="btn__trailing">
                    <ArrowUpRight size={16} />
                  </span>
                </Link>
              ) : undefined
            }
          />
        ) : (
          <div className="order-table">
            <div className="order-table__head" aria-hidden>
              <span>订单 / 客户</span>
              <span>产品</span>
              <span>交期</span>
              <span className="order-table__stages-head">
                {STAGE_NAMES.map((name) => (
                  <span key={name}>{name}</span>
                ))}
              </span>
              <span className="order-table__amount">金额</span>
              <span />
            </div>

            {orders.map((order) => {
              const hint = dueHint(order.dueDate);
              return (
                <Link
                  key={order.id}
                  to={`/orders/${order.id}`}
                  className="order-row"
                  aria-label={`查看订单 ${order.orderNo}`}
                >
                  <span className="order-row__primary">
                    <strong className="order-row__no">{order.orderNo}</strong>
                    <small className="order-row__customer">{order.customerName}</small>
                  </span>

                  <span className="order-row__product">
                    <span>{order.productSummary}</span>
                    <small>
                      {order.itemCount > 1 ? `${order.itemCount} 项 · ` : ''}
                      {formatNumber(order.totalQuantity)} 件
                    </small>
                  </span>

                  <span className="order-row__due" data-label="交期">
                    <span className="mono">{formatDateOnly(order.dueDate)}</span>
                    <small className={`due due--${hint.tone}`}>{hint.text}</small>
                  </span>

                  {order.stages ? (
                    <StageRibbon stages={order.stages} dataLabel="工序" />
                  ) : (
                    <span className="order-row__status" data-label="状态">
                      <StatusBadge status={order.status} dueDate={order.dueDate} />
                    </span>
                  )}

                  <span className={`order-row__amount mono${order.moneyVisible ? '' : ' is-muted'}`} data-label="金额">
                    {order.moneyVisible ? formatMoney(order.totalAmount) : '不可见'}
                  </span>

                  <span className="order-row__go" aria-hidden>
                    <ArrowRight size={16} />
                  </span>
                </Link>
              );
            })}
          </div>
        )}

        {meta && meta.totalPages > 1 ? (
          <div className="pager">
            <button
              type="button"
              className="pager__btn"
              onClick={() => setPage((value) => Math.max(1, value - 1))}
              disabled={page <= 1}
            >
              <ChevronLeft size={16} />
              上一页
            </button>
            <span className="pager__status mono">
              {page} / {meta.totalPages}
            </span>
            <button
              type="button"
              className="pager__btn"
              onClick={() => setPage((value) => Math.min(meta.totalPages, value + 1))}
              disabled={page >= meta.totalPages}
            >
              下一页
              <ChevronRight size={16} />
            </button>
          </div>
        ) : null}
      </section>
    </div>
  );
}