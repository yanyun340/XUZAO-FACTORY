import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError, apiGetPage, apiPost } from '../api/client';
import type { NotificationItem, PageMeta } from '../api/types';
import { ChevronLeft, ChevronRight } from '../components/Icons';
import { EmptyState, InlineNotice, LoadingBlock } from '../components/ui';
import { eventLabel, formatDateTime } from '../lib/format';

const PAGE_SIZE = 20;

export function NotificationsPage() {
  const navigate = useNavigate();
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [meta, setMeta] = useState<PageMeta | null>(null);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
    if (unreadOnly) params.set('unread', 'true');

    apiGetPage<NotificationItem[]>(`/notifications?${params.toString()}`)
      .then((result) => {
        if (cancelled) return;
        setItems(result.data);
        setMeta(result.meta);
      })
      .catch((caught) => {
        if (cancelled) return;
        setError(caught instanceof ApiError ? caught.message : '通知加载失败，请稍后重试');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [page, unreadOnly, reloadToken]);

  const markRead = useCallback(async (id: string) => {
    setBusyId(id);
    try {
      await apiPost(`/notifications/${id}/read`);
      setItems((current) =>
        current.map((item) =>
          item.id === id ? { ...item, readAt: new Date().toISOString() } : item,
        ),
      );
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '标记已读失败');
    } finally {
      setBusyId(null);
    }
  }, []);

  const openNotification = async (item: NotificationItem) => {
    if (!item.readAt) await markRead(item.id);
    if (item.orderId) navigate(`/orders/${item.orderId}`);
  };

  const markAllRead = async () => {
    setBusyId('all');
    try {
      await apiPost('/notifications/read-all');
      setReloadToken((token) => token + 1);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '全部标记已读失败');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="page">
      <header className="page-head">
        <div className="page-head__copy">
          <p className="eyebrow">INBOX / 通知中心</p>
          <h1 className="page-title">通知</h1>
          <p className="page-lede">订单流转产生的管理员提醒。点击可直接跳到对应订单。</p>
        </div>
        <div className="page-head__action">
          <button
            type="button"
            className="btn btn--secondary"
            onClick={() => void markAllRead()}
            disabled={busyId === 'all' || (meta?.unread ?? 0) === 0}
          >
            <span className="btn__label">全部标记已读</span>
          </button>
        </div>
      </header>

      <div className="segmented" role="tablist" aria-label="通知筛选">
        <button
          type="button"
          role="tab"
          aria-selected={!unreadOnly}
          className={`segmented__item${!unreadOnly ? ' is-active' : ''}`}
          onClick={() => {
            setUnreadOnly(false);
            setPage(1);
          }}
        >
          全部{meta ? ` ${meta.total}` : ''}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={unreadOnly}
          className={`segmented__item${unreadOnly ? ' is-active' : ''}`}
          onClick={() => {
            setUnreadOnly(true);
            setPage(1);
          }}
        >
          未读{meta ? ` ${meta.unread}` : ''}
        </button>
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

      <section className="panel" aria-busy={loading}>
        {loading ? (
          <LoadingBlock lines={6} />
        ) : items.length === 0 ? (
          <EmptyState
            title={unreadOnly ? '没有未读通知' : '暂时没有通知'}
            description={
              unreadOnly
                ? '所有通知都已读完了。'
                : '订单流转产生事件后，管理员会在这里收到提醒。'
            }
          />
        ) : (
          <ul className="notice-list">
            {items.map((item) => (
              <li key={item.id} className={`notice-item${item.readAt ? '' : ' is-unread'}`}>
                <button type="button" className="notice-item__main" onClick={() => void openNotification(item)}>
                  <span className="notice-item__title">
                    {!item.readAt ? <span className="notice-item__dot" aria-hidden /> : null}
                    {item.title}
                  </span>
                  <span className="notice-item__body">{item.body}</span>
                  <span className="notice-item__meta mono">
                    {eventLabel(item.eventType)} · {formatDateTime(item.createdAt)}
                  </span>
                </button>
                <div className="notice-item__side">
                  {item.orderId ? (
                    <Link className="text-link" to={`/orders/${item.orderId}`}>
                      查看订单
                    </Link>
                  ) : null}
                  {!item.readAt ? (
                    <button
                      type="button"
                      className="text-btn"
                      onClick={() => void markRead(item.id)}
                      disabled={busyId === item.id}
                    >
                      标记已读
                    </button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
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