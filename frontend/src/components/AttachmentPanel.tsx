import { useEffect, useRef, useState } from 'react';
import { ApiError, apiDownload, apiGet, apiPostForm } from '../api/client';
import type { AttachmentItem } from '../api/types';
import { PlusIcon } from './Icons';
import { InlineNotice } from './ui';
import { formatDateTime } from '../lib/format';

const ACCEPT =
  '.pdf,.png,.jpg,.jpeg,.webp,.txt,.csv,.xlsx,.docx,application/pdf,image/png,image/jpeg,image/webp,text/plain,text/csv';

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export function AttachmentPanel({ orderId }: { orderId: string }) {
  const [items, setItems] = useState<AttachmentItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiGet<AttachmentItem[]>(`/orders/${orderId}/attachments`)
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
  }, [orderId]);

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
      const created = await apiPostForm<AttachmentItem>(`/orders/${orderId}/attachments`, form);
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