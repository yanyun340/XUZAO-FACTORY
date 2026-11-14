import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, apiGet } from '../api/client';
import type { DashboardData, NotificationSummary, OrderStatus } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { ArrowUpRight, RefreshIcon } from '../components/Icons';
import { RollingNumber } from '../components/RollingNumber';
import { EmptyState, InlineNotice, LoadingBlock, StatusBadge } from '../components/ui';
import {
  STATUS_META,
  dueHint,
  formatDateOnly,
  formatMoney,
  formatNumber,
} from '../lib/format';

const STATUS_ORDER: OrderStatus[] = [
  'PENDING_PURCHASE',
  'PURCHASING',
  'IN_PRODUCTION',
  'PENDING_QC',
  'QC_DONE',
  'PACKING',
  'SHIPPING',
  'COMPLETED',
];

/** 变化率芯片：正绿、负红、持平中性；不编造数据，只有可比区间才渲染。 */
function deltaChipClass(percent: number | null): string {
  if (percent === null || percent === 0) return 'kpi__chip kpi__chip--flat';
  return percent > 0 ? 'kpi__chip kpi__chip--up' : 'kpi__chip kpi__chip--down';
}

function deltaText(percent: number): string {
  return `${percent > 0 ? '+' : ''}${percent}%`;
}

function sharePercent(value: number, total: number): number {
  return total === 0 ? 0 : Math.round((value / total) * 100);
}

function today(): string {
  const now = new Date();
  const date = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: 'long',
    day: 'numeric',
  }).format(now);
  const weekday = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    weekday: 'long',
  }).format(now);
  return `${date} · ${weekday}`;
}

export function DashboardPage() {
  const { user } = useAuth();
  const [data, setData] = useState<DashboardData | null>(null);
  const [notice, setNotice] = useState<NotificationSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [filters, setFilters] = useState({ from: '', to: '', ownerId: '' });
  const [draft, setDraft] = useState({ from: '', to: '', ownerId: '' });

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    const params = new URLSearchParams();
    if (filters.from) params.set('from', filters.from);
    if (filters.to) params.set('to', filters.to);
    if (filters.ownerId) params.set('ownerId', filters.ownerId);
    const query = params.toString();

    Promise.all([
      apiGet<DashboardData>(`/dashboard${query ? `?${query}` : ''}`),
      apiGet<NotificationSummary>('/notifications/summary').catch(() => null),
    ])
      .then(([dashboard, summary]) => {
        if (cancelled) return;
        setData(dashboard);
        setNotice(summary);
      })
      .catch((caught) => {
        if (cancelled) return;
        setError(caught instanceof ApiError ? caught.message : '看板加载失败，请稍后重试');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [reloadToken, filters]);

  const isAdmin = user?.role === 'ADMIN';
  // 非管理员后端直接返回 null，前端不再靠角色猜测字段是否存在。
  const profit = data?.profit ?? null;
  const counts = data?.statusCounts ?? {};
  const total = data?.totalOrders ?? 0;
  const inProduction = (counts['IN_PRODUCTION'] ?? 0) + (counts['PENDING_QC'] ?? 0) + (counts['QC_DONE'] ?? 0) + (counts['PACKING'] ?? 0);
  const pending = (counts['PENDING_PURCHASE'] ?? 0) + (counts['PURCHASING'] ?? 0);
  const completed = counts['COMPLETED'] ?? 0;
  const active = Math.max(0, total - completed);
  const completionRate = total === 0 ? 0 : Math.round((completed / total) * 100);

  return (
    <div className="page">
      <header className="page-head">
        <div className="page-head__copy">
          <p className="eyebrow">TODAY / {today()}</p>
          <h1 className="page-title">工厂看板</h1>
          <p className="page-lede">订单分布、生产进度与利润汇总，全部来自当前数据库的真实记录。</p>
        </div>
        <div className="page-head__action dash-actions">
          {notice && notice.unread > 0 ? (
            <Link className="dash-bell" to="/notifications">
              <span className="dash-bell__dot" aria-hidden />
              {notice.unread} 条未读通知
            </Link>
          ) : null}
          <button
            type="button"
            className={loading ? 'icon-btn icon-btn--spin' : 'icon-btn'}
            onClick={() => setReloadToken((token) => token + 1)}
            title="刷新看板"
            aria-label="刷新看板"
            aria-busy={loading}
          >
            <RefreshIcon size={17} />
          </button>
          <Link className="btn btn--primary" to="/orders">
            <span className="btn__label">订单总览</span>
            <span className="btn__trailing">
              <ArrowUpRight size={16} />
            </span>
          </Link>
        </div>
      </header>

      <form
        className="audit-filters"
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          setFilters({ ...draft });
        }}
      >
        <label className="audit-filters__field">
          <span>起始日期</span>
          <input
            className="input"
            type="date"
            value={draft.from}
            onChange={(event) => setDraft({ ...draft, from: event.target.value })}
          />
        </label>
        <label className="audit-filters__field">
          <span>结束日期</span>
          <input
            className="input"
            type="date"
            value={draft.to}
            onChange={(event) => setDraft({ ...draft, to: event.target.value })}
          />
        </label>
        <label className="audit-filters__field">
          <span>负责人</span>
          <select
            className="input"
            value={draft.ownerId}
            onChange={(event) => setDraft({ ...draft, ownerId: event.target.value })}
          >
            <option value="">全部</option>
            {(data?.owners ?? []).map((owner) => (
              <option key={owner.id} value={owner.id}>
                {owner.displayName}
              </option>
            ))}
          </select>
        </label>
        <div className="audit-filters__actions">
          <button type="submit" className="btn btn--sm">
            <span className="btn__label">筛选</span>
          </button>
          <button
            type="button"
            className="text-btn"
            onClick={() => {
              setDraft({ from: '', to: '', ownerId: '' });
              setFilters({ from: '', to: '', ownerId: '' });
            }}
          >
            清空
          </button>
        </div>
      </form>

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

      {loading ? (
        <LoadingBlock lines={7} />
      ) : !data ? (
        <EmptyState title="暂无看板数据" description="订单创建后这里会自动汇总。" />
      ) : (
        <>
          <section className="kpi-grid" aria-label="关键指标">
            <article className="kpi">
              <div className="kpi__top">
                <p className="kpi__label">订单总数</p>
                {data.inflow.createdDeltaPercent !== null ? (
                  <span
                    className={deltaChipClass(data.inflow.createdDeltaPercent)}
                    title={`近 7 天新增 ${data.inflow.createdRecent7d} 单 · 前 7 天 ${data.inflow.createdPrevious7d} 单`}
                  >
                    {deltaText(data.inflow.createdDeltaPercent)}
                  </span>
                ) : null}
              </div>
              <strong className="kpi__value">{formatNumber(total)}</strong>
              <p className="kpi__note">累计创建 · 近 7 天新增 {formatNumber(data.inflow.createdRecent7d)} 单</p>
            </article>
            <article className="kpi">
              <div className="kpi__top">
                <p className="kpi__label">在产订单</p>
                {total > 0 ? (
                  <span className="kpi__chip kpi__chip--share" title="占全部订单比例">
                    占 {sharePercent(inProduction, total)}%
                  </span>
                ) : null}
              </div>
              <strong className="kpi__value">{formatNumber(inProduction)}</strong>
              <p className="kpi__note">生产 · 质检 · 包装</p>
            </article>
            <article className="kpi">
              <div className="kpi__top">
                <p className="kpi__label">待采购</p>
                {total > 0 ? (
                  <span className="kpi__chip kpi__chip--share" title="占全部订单比例">
                    占 {sharePercent(pending, total)}%
                  </span>
                ) : null}
              </div>
              <strong className="kpi__value">{formatNumber(pending)}</strong>
              <p className="kpi__note">含采购中</p>
            </article>
            <article className="kpi">
              <div className="kpi__top">
                <p className="kpi__label">完成率</p>
                {data.inflow.completedDeltaPercent !== null ? (
                  <span
                    className={deltaChipClass(data.inflow.completedDeltaPercent)}
                    title={`近 7 天完成 ${data.inflow.completedRecent7d} 单 · 前 7 天 ${data.inflow.completedPrevious7d} 单`}
                  >
                    {deltaText(data.inflow.completedDeltaPercent)}
                  </span>
                ) : null}
              </div>
              <strong className="kpi__value">{completionRate}%</strong>
              <p className="kpi__note">
                {formatNumber(completed)} / {formatNumber(total)} 已完成
              </p>
            </article>
          </section>

          <div className="dash-grid">
            <section className="panel panel--pad dash-panel">
              <div className="panel__head">
                <div>
                  <h2 className="panel__title">订单状态分布</h2>
                  <p className="panel__meta">按当前状态统计，共 {formatNumber(active)} 单未完成</p>
                </div>
              </div>

              {total === 0 ? (
                <p className="detail-card__empty">还没有订单。</p>
              ) : (
                <>
                  <div className="dist" role="img" aria-label="订单状态分布条">
                    {STATUS_ORDER.map((status) => {
                      const value = counts[status] ?? 0;
                      if (value === 0) return null;
                      return (
                        <span
                          key={status}
                          className={`dist__seg dist__seg--${STATUS_META[status].chart}`}
                          style={{ flexGrow: value }}
                          title={`${STATUS_META[status].label} ${value} 单`}
                        />
                      );
                    })}
                  </div>
                  <ul className="dist-legend">
                    {STATUS_ORDER.map((status) => (
                      <li key={status} className="dist-legend__item">
                        <span
                          className={`dist-legend__dot dist-legend__dot--${STATUS_META[status].chart}`}
                          aria-hidden
                        />
                        <Link className="dist-legend__label" to={`/orders?status=${status}`}>
                          {STATUS_META[status].label}
                        </Link>
                        <span className="dist-legend__value mono">{counts[status] ?? 0}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </section>

            <section className="panel panel--pad dash-panel">
              <div className="panel__head">
                <div>
                  <h2 className="panel__title">{isAdmin ? '利润汇总' : '生产进度'}</h2>
                  <p className="panel__meta">
                    {isAdmin ? '销售额 − 采购成本 − 生产成本' : '全部生产任务与已反馈数量'}
                  </p>
                </div>
              </div>

              {isAdmin && profit ? (
                <>
                  <dl className="profit profit--dash">
                    <div className="profit__item">
                      <dt>销售额</dt>
                      <dd className="mono">
                        <RollingNumber
                          key={`sales-${reloadToken}`}
                          value={formatMoney(profit.sales)}
                        />
                      </dd>
                    </div>
                    <div className="profit__item">
                      <dt>采购成本</dt>
                      <dd className="mono">
                        <RollingNumber
                          key={`purchase-${reloadToken}`}
                          value={formatMoney(profit.purchaseCost)}
                          delay={90}
                        />
                      </dd>
                    </div>
                    <div className="profit__item">
                      <dt>生产成本</dt>
                      <dd className="mono">
                        <RollingNumber
                          key={`production-${reloadToken}`}
                          value={formatMoney(profit.productionCost)}
                          delay={180}
                        />
                      </dd>
                    </div>
                    <div className="profit__item profit__item--total">
                      <dt>毛利</dt>
                      <dd className="mono">
                        <RollingNumber
                          key={`profit-${reloadToken}`}
                          value={formatMoney(profit.profit)}
                          delay={270}
                        />
                        <span className="profit__margin">{profit.marginPercent}%</span>
                      </dd>
                    </div>
                  </dl>
                  <p className="dash-footnote">
                    生产成本 = 有效完成量 × 工艺单价；电镀成本按业务口径计 0。
                  </p>
                </>
              ) : (
                <>
                  <div className="progress-stat">
                    <div className="progress-stat__row">
                      <span>生产任务</span>
                      <strong className="mono">{formatNumber(data.production.tasks)}</strong>
                    </div>
                    <div className="progress-stat__row">
                      <span>已反馈数量</span>
                      <strong className="mono">{formatNumber(data.production.completedFeedback)}</strong>
                    </div>
                  </div>
                  <p className="dash-footnote">金额与利润仅管理员可见，服务端已按角色脱敏。</p>
                </>
              )}
            </section>
          </div>

          <section className="panel panel--pad dash-panel">
            <div className="panel__head">
              <div>
                <h2 className="panel__title">生产看板</h2>
                <p className="panel__meta">按部门汇总当前筛选范围内的任务与完成量</p>
              </div>
            </div>
            {data.productionBoard.length === 0 ? (
              <p className="detail-card__empty">当前筛选下还没有生产任务。</p>
            ) : (
              <div className="progress-stat">
                {data.productionBoard.map((row) => {
                  const percent =
                    row.plannedQty === 0
                      ? 0
                      : Math.round((row.completedQty / row.plannedQty) * 100);
                  return (
                    <div className="progress-stat__row" key={row.departmentId}>
                      <span>
                        {row.departmentName} · {row.tasks} 个任务
                      </span>
                      <strong className="mono">
                        {formatNumber(row.completedQty)} / {formatNumber(row.plannedQty)}（{percent}%）
                      </strong>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <div className="dash-grid">
            <section className="panel panel--pad dash-panel">
              <div className="panel__head">
                <div>
                  <h2 className="panel__title">库存汇总</h2>
                  <p className="panel__meta">手工台账当前数量，包装与发货不会自动扣减</p>
                </div>
              </div>
              <div className="progress-stat">
                <div className="progress-stat__row">
                  <span>配件库存</span>
                  <strong className="mono">{formatNumber(data.inventory.parts)}</strong>
                </div>
                <div className="progress-stat__row">
                  <span>成品库存</span>
                  <strong className="mono">{formatNumber(data.inventory.products)}</strong>
                </div>
              </div>
            </section>

            <section className="panel panel--pad dash-panel">
              <div className="panel__head">
                <div>
                  <h2 className="panel__title">发货完成率</h2>
                  <p className="panel__meta">已发货数量 ÷ 订单应交数量</p>
                </div>
              </div>
              <div className="progress-stat">
                <div className="progress-stat__row">
                  <span>已发货 / 应交</span>
                  <strong className="mono">
                    {formatNumber(data.shipping.shippedQty)} /{' '}
                    {formatNumber(data.shipping.orderQty)}
                  </strong>
                </div>
                <div className="progress-stat__row">
                  <span>完成率</span>
                  <strong className="mono">{data.shipping.completionPercent}%</strong>
                </div>
              </div>
            </section>
          </div>

          <section className="panel panel--table">
            <div className="panel__head">
              <div>
                <h2 className="panel__title">最近订单</h2>
                <p className="panel__meta">最近创建的 5 张订单</p>
              </div>
              <Link className="text-link" to="/orders">
                查看全部
              </Link>
            </div>

            {data.recentOrders.length === 0 ? (
              <EmptyState title="还没有订单" description="创建第一张订单后，看板会自动汇总。" />
            ) : (
              <div className="dash-list">
                <div className="dash-list__head" aria-hidden>
                  <span>订单 / 客户</span>
                  <span>产品</span>
                  <span>状态</span>
                  <span>交期</span>
                  <span>金额</span>
                </div>
                {data.recentOrders.map((order) => {
                  const hint = dueHint(order.dueDate);
                  return (
                    <Link className="dash-list__row" key={order.id} to={`/orders/${order.id}`}>
                      <span className="dash-list__main">
                        <strong className="mono">{order.orderNo}</strong>
                        <small>{order.customerName}</small>
                      </span>
                      <span className="dash-list__product">{order.productSummary}</span>
                      <StatusBadge status={order.status} dueDate={order.dueDate} />
                      <span className="dash-list__due">
                        <span className="mono">{formatDateOnly(order.dueDate)}</span>
                        <small className={`due due--${hint.tone}`}>{hint.text}</small>
                      </span>
                      <span className="dash-list__amount mono">
                        {order.moneyVisible ? formatMoney(order.totalAmount) : '—'}
                      </span>
                    </Link>
                  );
                })}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}