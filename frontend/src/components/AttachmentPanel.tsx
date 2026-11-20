import { useEffect, useRef, useState } from 'react';
import { ApiError, apiDelete, apiDownload, apiGet, apiPostForm } from '../api/client';
import type { AttachmentItem, OrderDetail } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { PlusIcon } from './Icons';
import { InlineNotice } from './ui';
import { formatDateTime } from '../lib/format';

type OwnerType = 'order' | 'purchase' | 'production' | 'qc' | 'shipment';

const ACCEPT =
  '.pdf,.png,.jpg,.jpeg,.webp,.txt,.csv,.xlsx,.docx,application/pdf,image/png,image/jpeg,image/webp,text/plain,text/csv';

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export function AttachmentPanel({
  orderId,
  ownerType,
  ownerId,
}: {
  orderId?: string;
  ownerType?: OwnerType;
  ownerId?: string;
}) {
  const { user } = useAuth();
  const [items, setItems] = useState<AttachmentItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const basePath =
    ownerType && ownerId ? `/${ownerType}/${ownerId}/attachments` : `/orders/${orderId}/attachments`;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiGet<AttachmentItem[]>(basePath)
      .then((result) => {
        if (!cancelled) setItems(result);
      })
      .catch((caught) => {
        if (!cancelled) {
          setError(caught instanceof ApiError ? caught.message : '附件加载失败');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [basePath]);

  const upload = async (file: File) => {
    if (file.size > 5 * 1024 * 1024) {
      setError('文件超过 5MB 限制');
      return;
    }

    setUploading(true);
    setError(null);
    const form = new FormData();
    form.append('file', file);

    try {
      const created = await apiPostForm<AttachmentItem>(basePath, form);
      setItems((current) => [created, ...current]);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '上传失败，请稍后重试');
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const download = async (item: AttachmentItem) => {
    setDownloadingId(item.id);
    setError(null);
    try {
      const { blob, fileName } = await apiDownload(`/attachments/${item.id}/download`);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = fileName || item.fileName;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '下载失败，请稍后重试');
    } finally {
      setDownloadingId(null);
    }
  };

  const remove = async (item: AttachmentItem) => {
    if (!window.confirm(`删除附件「${item.fileName}」？元数据保留 7 天后清理。`)) return;
    setDeletingId(item.id);
    setError(null);
    try {
      await apiDelete(`/attachments/${item.id}`);
      setItems((current) => current.filter((row) => row.id !== item.id));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '删除失败，请稍后重试');
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="bezelt">
      <div className="detail-card detail-card--tight">
        <div className="detail-card__head">
          <h2 className="detail-card__small-title">附件</h2>
          <span className="detail-card__note mono">{items.length} FILES</span>
        </div>

        {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}

        {loading ? (
          <p className="detail-card__empty">读取中…</p>
        ) : items.length === 0 ? (
          <p className="detail-card__empty">还没有附件。支持 PDF、图片、Excel、Word、CSV、TXT，单个不超过 5MB。</p>
        ) : (
          <ul className="attach-list">
            {items.map((item) => (
              <li key={item.id} className="attach-item">
                <button
                  type="button"
                  className="attach-item__name"
                  onClick={() => void download(item)}
                  disabled={downloadingId === item.id}
                  title="下载附件"
                >
                  <span className="attach-item__title">{item.fileName}</span>
                  <span className="attach-item__meta mono">
                    {humanSize(item.size)} · {formatDateTime(item.createdAt)}
                  </span>
                </button>
                <span className="attach-item__by">{item.uploadedByName}</span>
                {user?.role === 'ADMIN' || item.uploadedById === user?.id ? (
                  <button
                    type="button"
                    className="text-btn"
                    onClick={() => void remove(item)}
                    disabled={deletingId === item.id}
                  >
                    {deletingId === item.id ? '删除中…' : '删除'}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        <button
          type="button"
          className="attach-add"
          onClick={() => inputRef.current?.click()}
          disabled={uploading}
        >
          <PlusIcon size={15} />
          {uploading ? '上传中…' : '上传附件'}
        </button>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void upload(file);
          }}
        />
      </div>
    </div>
  );
}
/** R17F：在同一张订单详情里切换附件所属层级。 */
export function AttachmentScopes({ order }: { order: OrderDetail }) {
  const flow = order.flow;
  const scopes: Array<{ key: OwnerType; label: string; id: string }> = [
    { key: 'order', label: '订单', id: order.id },
  ];
  if (flow.purchase) scopes.push({ key: 'purchase', label: '采购单', id: flow.purchase.id });
  if (flow.production) scopes.push({ key: 'production', label: '生产任务', id: flow.production.id });
  if (flow.qc) scopes.push({ key: 'qc', label: '质检记录', id: flow.qc.id });
  if (flow.shipping.records[0]) {
    scopes.push({ key: 'shipment', label: '发货记录', id: flow.shipping.records[0].id });
  }

  const [active, setActive] = useState<OwnerType>('order');
  const current = scopes.find((scope) => scope.key === active) ?? scopes[0]!;

  return (
    <div>
      {scopes.length > 1 ? (
        <div className="segmented" role="tablist" aria-label="附件所属层级">
          {scopes.map((scope) => (
            <button
              key={scope.key}
              type="button"
              role="tab"
              aria-selected={current.key === scope.key}
              className={`segmented__item${current.key === scope.key ? ' is-active' : ''}`}
              onClick={() => setActive(scope.key)}
            >
              {scope.label}
            </button>
          ))}
        </div>
      ) : null}
      <AttachmentPanel
        key={`${current.key}:${current.id}`}
        ownerType={current.key}
        ownerId={current.id}
      />
    </div>
  );
}
