import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, apiGetPage } from '../api/client';
import type { ExceptionItem, PageMeta } from '../api/types';
import { ArrowRight } from '../components/Icons';
import { EmptyState, InlineNotice, LoadingBlock } from '../components/ui';
import { formatDateTime } from '../lib/format';

export function ExceptionsPage() {
  const [items, setItems] = useState<ExceptionItem[]>([]);
  const [meta, setMeta] = useState<PageMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    apiGetPage<ExceptionItem[]>('/exceptions?page=1&pageSize=50')
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
  }, []);

  return (
    <div className="page">
      <header className="page-head">
        <div className="page-head__copy">
          <p className="eyebrow">EXCEPTIONS / 现场异常</p>
          <h1 className="page-title">异常上报</h1>
          <p className="page-lede">
            生产、包装等现场人员从订单页提交的异常，按时间倒序汇总在这里。
          </p>
        </div>
      </header>

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
            title="还没有异常记录"
            description="现场人员在订单详情页点击「上报异常」后，记录会出现在这里。"
          />
        ) : (
          <ul className="exception-list">
            {items.map((item) => (
              <li className="exception-item" key={item.id}>
                <span className={`exception-item__status exception-item__status--${item.status.toLowerCase()}`}>
                  {item.status === 'OPEN' ? '待处理' : item.status}
                </span>
                <div className="exception-item__body">
                  <p className="exception-item__text">{item.description}</p>
                  <p className="exception-item__meta mono">
                    {item.reporterName} · {formatDateTime(item.createdAt)}
                    {item.orderNo ? ` · ${item.orderNo}` : ''}
                  </p>
                </div>
                {item.orderId ? (
                  <Link className="text-link exception-item__link" to={`/orders/${item.orderId}`}>
                    查看订单
                    <ArrowRight size={14} />
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}