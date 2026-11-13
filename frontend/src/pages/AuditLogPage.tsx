import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ApiError, apiGet, apiGetPage } from '../api/client';
import type { AuditFacets, AuditLogItem, PageMeta } from '../api/types';
import { DataTable } from '../components/DataTable';
import { SearchIcon } from '../components/Icons';
import { Pagination } from '../components/Pagination';
import { Button, EmptyState, InlineNotice, LoadingBlock } from '../components/ui';
import {
  auditActionLabel,
  auditResourceLabel,
  formatDateTime,
  formatNumber,
} from '../lib/format';

const PAGE_SIZE = 20;

interface Filters {
  keyword: string;
  action: string;
  resourceType: string;
  actorId: string;
  from: string;
  to: string;
}

const EMPTY_FILTERS: Filters = {
  keyword: '',
  action: '',
  resourceType: '',
  actorId: '',
  from: '',
  to: '',
};

/** 日期选择器给的是本地日期，补上东八区偏移，服务端按带时区的时间比较。 */
function toIsoStart(value: string): string | undefined {
  return value ? `${value}T00:00:00+08:00` : undefined;
}

function toIsoEnd(value: string): string | undefined {
  return value ? `${value}T23:59:59+08:00` : undefined;
}

function preview(value: unknown): string {
  if (value === null || value === undefined) return '无记录';
  if (typeof value === 'string') return value;
  const text = JSON.stringify(value);
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

export function AuditLogPage() {
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [draft, setDraft] = useState<Filters>(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<AuditLogItem[]>([]);
  const [meta, setMeta] = useState<PageMeta | null>(null);
  const [facets, setFacets] = useState<AuditFacets | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiGet<AuditFacets>('/audit-logs/facets')
      .then((result) => {
        if (!cancelled) setFacets(result);
      })
      .catch(() => {
        // 下拉选项失败不影响主列表
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
    if (filters.keyword) params.set('keyword', filters.keyword);
    if (filters.action) params.set('action', filters.action);
    if (filters.resourceType) params.set('resourceType', filters.resourceType);
    if (filters.actorId) params.set('actorId', filters.actorId);
    const from = toIsoStart(filters.from);
    const to = toIsoEnd(filters.to);
    if (from) params.set('from', from);
    if (to) params.set('to', to);

    apiGetPage<AuditLogItem[]>(`/audit-logs?${params.toString()}`)
      .then((result) => {
        if (cancelled) return;
        setItems(result.data);
        setMeta(result.meta);
      })
      .catch((caught) => {
        if (cancelled) return;
        setError(caught instanceof ApiError ? caught.message : '审计日志加载失败，请稍后重试');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [filters, page]);

  const submit = useCallback((event: FormEvent) => {
    event.preventDefault();
    setPage(1);
    setFilters({ ...draft, keyword: draft.keyword.trim() });
  }, [draft]);

  const reset = useCallback(() => {
    setDraft(EMPTY_FILTERS);
    setFilters(EMPTY_FILTERS);
    setPage(1);
  }, []);

  const activeCount =
    (filters.keyword ? 1 : 0) +
    (filters.action ? 1 : 0) +
    (filters.resourceType ? 1 : 0) +
    (filters.actorId ? 1 : 0) +
    (filters.from ? 1 : 0) +
    (filters.to ? 1 : 0);

  return (
    <div className="page">
      <header className="page-head">
        <div className="page-head__copy">
          <p className="eyebrow">AUDIT / 审计日志</p>
          <h1 className="page-title">审计日志</h1>
          <p className="page-lede">
            每一次写操作都在业务事务内留下一条记录：谁、在什么时间、对哪个对象做了什么，改前改后的内容一并保存。
          </p>
        </div>
      </header>

      <form className="audit-filters" onSubmit={submit} role="search">
        <label className="search audit-filters__search">
          <SearchIcon size={17} />
          <input
            className="search__input"
            type="search"
            value={draft.keyword}
            onChange={(event) => setDraft({ ...draft, keyword: event.target.value })}
            placeholder="搜索动作、资源类型或请求 ID"
            aria-label="搜索审计日志"
          />
        </label>

        <label className="audit-filters__field">
          <span>动作</span>
          <select
            className="input"
            value={draft.action}
            onChange={(event) => setDraft({ ...draft, action: event.target.value })}
          >
            <option value="">全部</option>
            {(facets?.actions ?? []).map((action) => (
              <option key={action} value={action}>
                {auditActionLabel(action)}
              </option>
            ))}
          </select>
        </label>

        <label className="audit-filters__field">
          <span>对象</span>
          <select
            className="input"
            value={draft.resourceType}
            onChange={(event) => setDraft({ ...draft, resourceType: event.target.value })}
          >
            <option value="">全部</option>
            {(facets?.resourceTypes ?? []).map((type) => (
              <option key={type} value={type}>
                {auditResourceLabel(type)}
              </option>
            ))}
          </select>
        </label>

        <label className="audit-filters__field">
          <span>操作人</span>
          <select
            className="input"
            value={draft.actorId}
            onChange={(event) => setDraft({ ...draft, actorId: event.target.value })}
          >
            <option value="">全部</option>
            {(facets?.actors ?? []).map((actor) => (
              <option key={actor.id} value={actor.id}>
                {actor.displayName}
              </option>
            ))}
          </select>
        </label>

        {/* 起止日期作为一个整体换行，避免两个标签被拆到不同行 */}
        <div className="audit-filters__range">
          <label className="audit-filters__field">
            <span>起</span>
            <input
              className="input"
              type="date"
              value={draft.from}
              onChange={(event) => setDraft({ ...draft, from: event.target.value })}
            />
          </label>

          <label className="audit-filters__field">
            <span>止</span>
            <input
              className="input"
              type="date"
              value={draft.to}
              onChange={(event) => setDraft({ ...draft, to: event.target.value })}
            />
          </label>
        </div>

        <div className="audit-filters__actions">
          <Button type="submit" className="btn--sm">
            筛选
          </Button>
          <button type="button" className="text-btn" onClick={reset} disabled={activeCount === 0}>
            清空
          </button>
        </div>
      </form>

      {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}

      <section className="panel" aria-busy={loading}>
        <div className="panel__head">
          <div>
            <h2 className="panel__title">操作记录</h2>
            <p className="panel__meta">
              {meta ? `共 ${formatNumber(meta.total)} 条` : '读取中'}
              {activeCount > 0 ? ` · 已应用 ${activeCount} 个筛选条件` : ''}
            </p>
          </div>
        </div>

        {loading ? (
          <LoadingBlock lines={6} />
        ) : items.length === 0 ? (
          <EmptyState
            title="没有匹配的审计记录"
            description="换个关键词或清空筛选条件再试一次。"
            action={
              activeCount > 0 ? (
                <button type="button" className="btn btn--secondary" onClick={reset}>
                  <span className="btn__label">清空筛选</span>
                </button>
              ) : undefined
            }
          />
        ) : (
          <DataTable
            label="操作记录"
            tableClassName="audit-table"
            headClassName="audit-table__head"
            rowClassName={(item) => `audit-row${expanded === item.id ? ' is-open' : ''}`}
            rowKey={(item) => item.id}
            rows={items}
            expansion={{
              rowClassName: 'audit-detail-row',
              cellClassName: 'audit-row__detail',
              render: (item) =>
                expanded === item.id ? (
                  <>
                    <div className="audit-detail">
                      <p className="audit-detail__label">改前</p>
                      <pre className="audit-detail__json">{preview(item.before)}</pre>
                    </div>
                    <div className="audit-detail">
                      <p className="audit-detail__label">改后</p>
                      <pre className="audit-detail__json">{preview(item.after)}</pre>
                    </div>
                    <p className="audit-detail__request mono">请求 ID {item.requestId}</p>
                  </>
                ) : null,
            }}
            columns={[
              {
                key: 'who',
                title: '时间 / 操作人',
                className: 'audit-row__who',
                cell: (item) => (
                  <>
                    <strong className="mono">{formatDateTime(item.createdAt)}</strong>
                    <small>{item.actorName ?? '系统'}</small>
                  </>
                ),
              },
              {
                key: 'action',
                title: '动作',
                className: 'audit-row__action',
                cell: (item) => (
                  <>
                    <strong>{auditActionLabel(item.action)}</strong>
                    <small className="mono">{item.action}</small>
                  </>
                ),
              },
              {
                key: 'resource',
                title: '对象',
                className: 'audit-row__resource',
                cell: (item) => (
                  <>
                    <strong>{auditResourceLabel(item.resourceType)}</strong>
                    <small className="mono">
                      {item.resourceId ? item.resourceId.slice(0, 8) : '—'}
                    </small>
                  </>
                ),
              },
              {
                key: 'result',
                title: '结果',
                className: (item) =>
                  `audit-row__result audit-row__result--${item.result.toLowerCase()}`,
                cell: (item) => (item.result === 'SUCCESS' ? '成功' : '失败'),
              },
              {
                key: 'toggle',
                title: '操作',
                className: 'audit-row__toggle-cell',
                cell: (item) => {
                  const isOpen = expanded === item.id;
                  return (
                    <button
                      type="button"
                      className="text-btn audit-row__toggle"
                      aria-expanded={isOpen}
                      onClick={() => setExpanded(isOpen ? null : item.id)}
                    >
                      {isOpen ? '收起' : '详情'}
                    </button>
                  );
                },
              },
            ]}
          />
        )}

        <Pagination page={page} totalPages={meta?.totalPages ?? 1} onChange={setPage} />
      </section>
    </div>
  );
}