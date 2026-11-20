import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, apiGetPage, apiPatch } from '../api/client';
import type {
  ExceptionCategory,
  ExceptionItem,
  ExceptionStatus,
  PageMeta,
} from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { ArrowRight } from '../components/Icons';
import { EmptyState, InlineNotice, LoadingBlock } from '../components/ui';
import {
  EXCEPTION_CATEGORY_LABEL,
  EXCEPTION_STATUS_LABEL,
  exceptionCategoryLabel,
  exceptionStatusLabel,
  formatDateTime,
} from '../lib/format';

const PAGE_SIZE = 50;

const CATEGORY_OPTIONS = Object.entries(EXCEPTION_CATEGORY_LABEL).map(([value, label]) => ({
  value: value as ExceptionCategory,
  label,
}));

const STATUS_OPTIONS = Object.entries(EXCEPTION_STATUS_LABEL).map(([value, label]) => ({
  value: value as ExceptionStatus,
  label,
}));

type Filters = {
  status: ExceptionStatus | '';
  category: ExceptionCategory | '';
  keyword: string;
};

const EMPTY_FILTERS: Filters = { status: '', category: '', keyword: '' };

export function ExceptionsPage() {
  const { user } = useAuth();
  const [items, setItems] = useState<ExceptionItem[]>([]);
  const [meta, setMeta] = useState<PageMeta | null>(null);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [draft, setDraft] = useState<Filters>(EMPTY_FILTERS);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [expectedAt, setExpectedAt] = useState('');
  const [resolution, setResolution] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    const params = new URLSearchParams({ page: '1', pageSize: String(PAGE_SIZE) });
    if (filters.status) params.set('status', filters.status);
    if (filters.category) params.set('category', filters.category);
    if (filters.keyword) params.set('keyword', filters.keyword);

    apiGetPage<ExceptionItem[]>(`/exceptions?${params.toString()}`)
      .then((result) => {
        if (cancelled) return;
        setItems(result.data);
        setMeta(result.meta);
      })
      .catch((caught) => {
        if (cancelled) return;
        setError(caught instanceof ApiError ? caught.message : '异常列表加载失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [filters, reloadToken]);

  const applyFilters = useCallback(() => {
    setFilters({ ...draft, keyword: draft.keyword.trim() });
  }, [draft]);

  const update = async (item: ExceptionItem, body: Record<string, unknown>) => {
    setBusyId(item.id);
    setError(null);
    try {
      await apiPatch(`/exceptions/${item.id}`, body);
      setActiveId(null);
      setResolution('');
      setReloadToken((token) => token + 1);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '异常处置失败');
    } finally {
      setBusyId(null);
    }
  };

  const startHandling = (item: ExceptionItem) =>
    update(item, {
      status: 'IN_PROGRESS',
      handlerId: user?.id ?? null,
      ...(expectedAt ? { expectedAt: new Date(expectedAt).toISOString() } : {}),
    });

  const resolve = (item: ExceptionItem) => {
    if (!resolution.trim()) {
      setError('标记解决前请填写处理说明');
      return;
    }
    void update(item, { status: 'RESOLVED', resolution: resolution.trim() });
  };

  return (
    <div className="page">
      <header className="page-head">
        <div className="page-head__copy">
          <p className="eyebrow">EXCEPTIONS / 现场异常</p>
          <h1 className="page-title">异常上报</h1>
          <p className="page-lede">
            现场人员提交的问题在这里分派、跟踪和关闭。处置只推进状态，不篡改生产数量。
          </p>
        </div>
      </header>

      <form
        className="audit-filters exception-filters"
        onSubmit={(event) => {
          event.preventDefault();
          applyFilters();
        }}
        role="search"
      >
        <label className="search audit-filters__search">
          <input
            className="search__input"
            type="search"
            value={draft.keyword}
            onChange={(event) => setDraft({ ...draft, keyword: event.target.value })}
            placeholder="搜索异常描述"
            aria-label="搜索异常"
          />
        </label>

        <label className="audit-filters__field">
          <span>状态</span>
          <select
            className="input"
            value={draft.status}
            onChange={(event) =>
              setDraft({ ...draft, status: event.target.value as ExceptionStatus | '' })
            }
          >
            <option value="">全部</option>
            {STATUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className="audit-filters__field">
          <span>分类</span>
          <select
            className="input"
            value={draft.category}
            onChange={(event) =>
              setDraft({ ...draft, category: event.target.value as ExceptionCategory | '' })
            }
          >
            <option value="">全部</option>
            {CATEGORY_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
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
              setDraft(EMPTY_FILTERS);
              setFilters(EMPTY_FILTERS);
            }}
          >
            清空
          </button>
        </div>
      </form>

      {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}

      <section className="panel" aria-busy={loading}>
        <div className="panel__head">
          <div>
            <h2 className="panel__title">异常记录</h2>
            <p className="panel__meta">{meta ? `共 ${meta.total} 条` : '读取中'}</p>
          </div>
        </div>

        {loading ? (
          <LoadingBlock lines={5} />
        ) : items.length === 0 ? (
          <EmptyState
            title="没有匹配的异常记录"
            description="现场人员在订单详情页点击「上报异常」后，记录会出现在这里。"
          />
        ) : (
          <ul className="exception-list">
            {items.map((item) => {
              const open = activeId === item.id;
              const canStart = item.status === 'OPEN';
              const canResolve = item.status === 'IN_PROGRESS';
              const canClose = item.status === 'OPEN' || item.status === 'IN_PROGRESS';

              return (
                <li className="exception-item exception-item--stack" key={item.id}>
                  <div className="exception-item__head">
                    <span
                      className={`exception-item__status exception-item__status--${item.status.toLowerCase()}`}
                    >
                      {exceptionStatusLabel(item.status)}
                    </span>
                    <span className="tag">{exceptionCategoryLabel(item.category)}</span>
                    <div className="exception-item__body">
                      <p className="exception-item__text">{item.description}</p>
                      <p className="exception-item__meta mono">
                        {item.reporterName} · {formatDateTime(item.createdAt)}
                        {item.handlerName ? ` · 处理人 ${item.handlerName}` : ''}
                        {item.expectedAt ? ` · 预计 ${formatDateTime(item.expectedAt)}` : ''}
                        {item.orderNo ? ` · ${item.orderNo}` : ''}
                      </p>
                      {item.resolution ? (
                        <p className="exception-item__resolution">
                          处理说明：{item.resolution}
                        </p>
                      ) : null}
                    </div>
                    <div className="exception-item__actions">
                      {item.orderId ? (
                        <Link className="text-link" to={`/orders/${item.orderId}`}>
                          查看订单
                          <ArrowRight size={14} />
                        </Link>
                      ) : null}
                      {item.status !== 'CLOSED' ? (
                        <button
                          type="button"
                          className="text-btn"
                          onClick={() => {
                            setActiveId(open ? null : item.id);
                            setResolution('');
                            setExpectedAt('');
                            setError(null);
                          }}
                          aria-expanded={open}
                        >
                          {open ? '收起' : '处置'}
                        </button>
                      ) : null}
                    </div>
                  </div>

                  {open ? (
                    <div className="exception-dispose">
                      <label className="field">
                        <span className="field__label">预计完成时间</span>
                        <input
                          className="input"
                          type="datetime-local"
                          value={expectedAt}
                          onChange={(event) => setExpectedAt(event.target.value)}
                        />
                      </label>
                      {canResolve || item.status === 'RESOLVED' ? (
                        <label className="field">
                          <span className="field__label">处理说明</span>
                          <input
                            className="input"
                            value={resolution}
                            onChange={(event) => setResolution(event.target.value)}
                            placeholder="例如：已更换刀具并复检"
                          />
                        </label>
                      ) : null}
                      <div className="exception-dispose__actions">
                        {canStart ? (
                          <button
                            type="button"
                            className="btn btn--sm"
                            disabled={busyId === item.id}
                            onClick={() => void startHandling(item)}
                          >
                            <span className="btn__label">开始处理</span>
                          </button>
                        ) : null}
                        {canResolve ? (
                          <button
                            type="button"
                            className="btn btn--sm"
                            disabled={busyId === item.id}
                            onClick={() => resolve(item)}
                          >
                            <span className="btn__label">标记解决</span>
                          </button>
                        ) : null}
                        {canClose ? (
                          <button
                            type="button"
                            className="btn btn--secondary btn--sm"
                            disabled={busyId === item.id}
                            onClick={() => void update(item, { status: 'CLOSED' })}
                          >
                            <span className="btn__label">关闭</span>
                          </button>
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}