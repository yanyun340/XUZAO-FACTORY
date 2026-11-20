import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom';
import { ApiError, apiGet } from '../api/client';
import type { OrderAction, OrderDetail } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { AttachmentScopes } from '../components/AttachmentPanel';
import { DataTable } from '../components/DataTable';
import { FlowLedger, FlowPanel, PriceVisibilityControl } from '../components/FlowPanel';
import { ReportException } from '../components/ReportException';
import { ArrowLeft, CheckIcon } from '../components/Icons';
import {
  EmptyState,
  InlineNotice,
  LoadingBlock,
  StatusBadge,
} from '../components/ui';
import {
  STATUS_FLOW,
  STATUS_META,
  currentStageIndex,
  dueHint,
  eventLabel,
  formatDateOnly,
  formatDateTime,
  formatMoney,
  formatNumber,
} from '../lib/format';

/** 下一步按真实记录推导，而不是只看状态：同一状态下是否已到货、已反馈，下一步责任人不同。 */
function nextStep(order: OrderDetail): { owner: string; text: string } {
  const { quantities, purchase, production, qc, packing } = order.flow;
  switch (order.status) {
    case 'PENDING_PURCHASE':
      return { owner: '管理员', text: '创建采购单，选择供应商与配件' };
    case 'PURCHASING':
      if (purchase && quantities.arrivedQty < quantities.purchaseQty) {
        return { owner: '物流', text: '登记采购到货数量' };
      }
      return { owner: '管理员', text: '采购已全部到货，下发生产任务' };
    case 'IN_PRODUCTION':
      if (production && !production.feedback) {
        return { owner: '生产', text: '反馈本工序完成数量' };
      }
      return { owner: '管理员', text: '生产已反馈，下发质检' };
    case 'PENDING_QC':
      if (!qc) return { owner: '品控', text: '录入质检结果（M 版本为全合格）' };
      return { owner: '管理员', text: '做质检放行决策，确定可包装数量' };
    case 'QC_DONE':
      return { owner: '管理员', text: '下发包装，交给包装人员登记' };
    case 'PACKING':
      if (packing.records.length === 0) return { owner: '包装', text: '按可包装剩余量登记包装' };
      return { owner: '管理员', text: '包装已完成，触发发货' };
    case 'SHIPPING':
      return { owner: '物流', text: '登记发货，足量后订单完成' };
    case 'COMPLETED':
      return { owner: '—', text: '订单已足量发货完成' };
  }
}


/**
 * 事件流里每一条都是已发生的事实：最后一条是「你在这里」（主色 + 外环），
 * 其余全部填完成绿。不给节点分重要等级——空心节点会被读成「未完成」。
 */
function nodeState(index: number, total: number): 'current' | 'done' {
  return index === total - 1 ? 'current' : 'done';
}

function eventDetail(payload: Record<string, unknown> | null): string | null {
  if (!payload) return null;
  const quantity = payload['quantity'];
  const releasedQty = payload['releasedQty'];
  if (typeof releasedQty === 'number') return `放行 ${releasedQty}`;
  if (typeof quantity === 'number') return `数量 ${quantity}`;
  const shippedTotal = payload['shippedTotal'];
  if (typeof shippedTotal === 'number') return `累计发货 ${shippedTotal}`;
  return null;
}

export function OrderDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const focusAction = (searchParams.get('action') as OrderAction | null) ?? null;
  const fromTasks = searchParams.get('from') === 'tasks';
  const scrolledRef = useRef<string | null>(null);
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ message: string; notFound: boolean } | null>(null);
  const [showCreated, setShowCreated] = useState(
    Boolean((location.state as { justCreated?: boolean } | null)?.justCreated),
  );

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setLoading(true);
    setError(null);

    apiGet<OrderDetail>(`/orders/${id}`)
      .then((result) => {
        if (!cancelled) setOrder(result);
      })
      .catch((caught) => {
        if (cancelled) return;
        if (caught instanceof ApiError) {
          setError({ message: caught.message, notFound: caught.status === 404 });
        } else {
          setError({ message: '订单加载失败，请稍后重试', notFound: false });
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [id]);

  // 从待办队列点进来：订单加载后把流转操作面板滚到视线中央，只滚一次
  useEffect(() => {
    if (!order || !focusAction) return;
    const key = `${order.id}:${focusAction}`;
    if (scrolledRef.current === key) return;
    const target = document.getElementById('flow-actions');
    if (!target) return;

    scrolledRef.current = key;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    target.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' });
  }, [order, focusAction]);

  if (loading) {
    return (
      <div className="page">
        <LoadingBlock lines={6} />
      </div>
    );
  }

  if (error?.notFound) {
    return (
      <div className="page">
        <EmptyState
          title="订单不存在"
          description="它可能已被删除，或者链接不完整。"
          action={
            <Link className="btn btn--secondary" to="/orders">
              <span className="btn__label">返回订单总览</span>
            </Link>
          }
        />
      </div>
    );
  }

  if (error || !order) {
    return (
      <div className="page">
        <InlineNotice tone="error">{error?.message ?? '订单加载失败'}</InlineNotice>
        <Link className="text-link" to="/orders">
          返回订单总览
        </Link>
      </div>
    );
  }

  // 已完成订单不再显示"剩余天数"，避免误导交期状态
  const hint =
    order.status === 'COMPLETED'
      ? { text: '已足量发货', tone: 'normal' as const }
      : dueHint(order.dueDate);
  const stage = currentStageIndex(order.status);
  const next = nextStep(order);
  const canSeeMoney = order.moneyVisible;
  const hasAction = order.allowedActions.some((action) => action !== 'view');

  return (
    <div className="page">
      <Link className="back-link" to={fromTasks ? '/tasks' : '/orders'}>
        <ArrowLeft size={16} />
        {fromTasks ? '返回待办' : '返回订单总览'}
      </Link>

      {showCreated ? (
        <InlineNotice tone="info">
          <span>订单 {order.orderNo} 已创建，已进入待采购状态。</span>
          <button type="button" className="notice__retry" onClick={() => setShowCreated(false)}>
            知道了
          </button>
        </InlineNotice>
      ) : null}

      <header className="detail-head">
        <div className="detail-head__main">
          <p className="eyebrow">ORDER / {order.orderNo}</p>
          <h1 className="page-title detail-head__title">{order.customerName}</h1>
          <div className="detail-head__meta">
            <StatusBadge status={order.status} dueDate={order.dueDate} />
            <span className={`due due--${hint.tone}`}>{hint.text}</span>
            <span className="dot-sep" aria-hidden />
            <span>交期 {formatDateOnly(order.dueDate)}</span>
            <span className="dot-sep" aria-hidden />
            <span>{order.itemCount} 项明细 · {formatNumber(order.totalQuantity)} 件</span>
          </div>
        </div>
        <div className="detail-head__amount">
          <span className="detail-head__amount-label">订单金额</span>
          <strong className="mono">
            {canSeeMoney ? formatMoney(order.totalAmount) : '按角色隐藏'}
          </strong>
        </div>
      </header>

      <section className="progress" aria-label="订单阶段">
        {STATUS_FLOW.map((status, index) => {
          const isDone = index < stage;
          const isCurrent = index === stage;
          return (
            <div
              key={status}
              className={`progress__step${isDone ? ' is-done' : ''}${isCurrent ? ' is-current' : ''}`}
            >
              <span className="progress__marker">
                {isDone ? <CheckIcon size={13} /> : String(index + 1).padStart(2, '0')}
              </span>
              <span className="progress__label">{STATUS_META[status].label}</span>
            </div>
          );
        })}
      </section>

      <div className="detail-grid">
        <div className="detail-grid__main">
          <section className="bezelt">
            <div className="detail-card">
              <div className="detail-card__head">
                <h2>产品明细</h2>
                <span className="detail-card__note mono">
                  {order.items.length} {order.items.length === 1 ? 'LINE' : 'LINES'}
                </span>
              </div>

              <DataTable
                label="产品明细"
                tableClassName="item-table"
                headClassName="item-table__head"
                rowClassName="item-table__row"
                rowKey={(item) => item.id}
                rows={order.items}
                columns={[
                  {
                    key: 'product',
                    title: '产品',
                    className: 'item-table__product',
                    cell: (item) => (
                      <>
                        <strong>{item.productName}</strong>
                        <small>{item.spec}</small>
                      </>
                    ),
                  },
                  {
                    key: 'quantity',
                    title: '数量',
                    className: 'mono',
                    cell: (item) => formatNumber(item.quantity),
                  },
                  {
                    key: 'unitPrice',
                    title: '单价',
                    className: 'mono',
                    cell: (item) => (canSeeMoney ? formatMoney(item.unitPrice) : '—'),
                  },
                  {
                    key: 'lineAmount',
                    title: '小计',
                    className: 'mono',
                    cell: (item) => (canSeeMoney ? formatMoney(item.lineAmount) : '—'),
                  },
                ]}
              />

              {!canSeeMoney ? (
                <p className="detail-card__lock">
                  当前角色无权查看订单金额与单价。金额字段在服务端返回前已脱敏。
                </p>
              ) : null}
            </div>
          </section>

          <FlowLedger order={order} />
        </div>

        <aside className="detail-grid__aside">
          {user?.role === 'ADMIN' && order.flow.production ? (
            <PriceVisibilityControl
              production={order.flow.production}
              onVisibleChange={(visible) =>
                setOrder((current) =>
                  current && current.flow.production
                    ? {
                        ...current,
                        flow: {
                          ...current.flow,
                          production: { ...current.flow.production, unitPriceVisible: visible },
                        },
                      }
                    : current,
                )
              }
            />
          ) : null}
          {hasAction ? (
            <FlowPanel order={order} onUpdated={setOrder} focusAction={focusAction} />
          ) : (
            <div className="bezelt">
              <div className="detail-card detail-card--tight">
                <p className="eyebrow">NEXT STEP</p>
                <h2 className="next-step__owner">{next.owner}</h2>
                <p className="next-step__text">{next.text}</p>
                <p className="next-step__hint">动作入口按角色显示，后端会再次校验权限与数量。</p>
              </div>
            </div>
          )}

          <div className="bezelt">
            <div className="detail-card detail-card--tight">
              <h2 className="detail-card__small-title">关键信息</h2>
              <dl className="kv">
                <div>
                  <dt>客户</dt>
                  <dd>{order.customerName}</dd>
                </div>
                <div>
                  <dt>联系人</dt>
                  <dd>{order.customerContact ?? '当前角色不可见'}</dd>
                </div>
                <div>
                  <dt>交期</dt>
                  <dd className="mono">{formatDateOnly(order.dueDate)}</dd>
                </div>
                <div>
                  <dt>创建人</dt>
                  <dd>{order.createdByName}</dd>
                </div>
                <div>
                  <dt>创建时间</dt>
                  <dd>{formatDateTime(order.createdAt)}</dd>
                </div>
                <div>
                  <dt>订单号</dt>
                  <dd className="mono">{order.orderNo}</dd>
                </div>
              </dl>
            </div>
          </div>

          {order.remark ? (
            <div className="bezelt">
              <div className="detail-card detail-card--tight">
                <h2 className="detail-card__small-title">备注</h2>
                <p className="remark-text">{order.remark}</p>
              </div>
            </div>
          ) : null}

          <AttachmentScopes order={order} />

          <ReportException orderId={order.id} />

          <p className="role-note">
            当前以「{user?.displayName ?? ''}」身份查看。金额、联系方式和后续动作均按角色控制。
          </p>
        </aside>
      </div>

      <section className="panel vtl-panel" aria-labelledby="order-history-title">
        <div className="panel__head">
          <div>
            <h2 className="panel__title" id="order-history-title">订单历程</h2>
            <p className="panel__meta">按发生顺序排列，全部来自订单事件流。</p>
          </div>
          <span className="panel__count mono">
            {order.timeline.length} {order.timeline.length === 1 ? 'EVENT' : 'EVENTS'}
          </span>
        </div>

        {order.timeline.length === 0 ? (
          <p className="detail-card__empty">暂时没有记录。</p>
        ) : (
          <ol className="vtl">
            {order.timeline.map((event, index) => {
              const state = nodeState(index, order.timeline.length);
              const detail = eventDetail(event.payload);
              return (
                <li
                  className={`vtl__item vtl__item--${index % 2 === 0 ? 'left' : 'right'}`}
                  key={event.id}
                >
                  <article className="vtl__card">
                    <time className="vtl__time" dateTime={event.createdAt}>
                      {formatDateTime(event.createdAt)}
                    </time>
                    <h3 className="vtl__title">{eventLabel(event.type)}</h3>
                    <p className="vtl__body">
                      {event.actorName}
                      {detail ? <span className="vtl__detail"> · {detail}</span> : null}
                    </p>
                  </article>
                  <span className={`vtl__node vtl__node--${state}`} aria-hidden />
                </li>
              );
            })}
          </ol>
        )}
      </section>
    </div>
  );
}