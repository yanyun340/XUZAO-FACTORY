import { useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { ApiError, apiDownload, apiPost, apiPostForm } from '../api/client';
import { useModalFocus } from '../hooks/useModalFocus';
import { Button, InlineNotice } from './ui';
import { announce } from './LiveAnnouncer';

type Entity = 'customer' | 'supplier' | 'part' | 'employee';

const ENTITIES: Array<{ value: Entity; label: string }> = [
  { value: 'customer', label: '客户' },
  { value: 'supplier', label: '供应商' },
  { value: 'part', label: '配件' },
  { value: 'employee', label: '员工' },
];

interface ImportIssue {
  rowNo: number;
  field: string;
  message: string;
}

interface PreflightResult {
  batchId: string;
  entity: string;
  rowCount: number;
  errorCount: number;
  errors: ImportIssue[];
}

export function ImportDialog({
  open,
  onClose,
  onImported,
}: {
  open: boolean;
  onClose: () => void;
  onImported: () => void;
}) {
  const [entity, setEntity] = useState<Entity>('customer');
  const [result, setResult] = useState<PreflightResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cardRef = useModalFocus(open, onClose, { canClose: () => !busy });

  const reset = () => {
    setResult(null);
    setError(null);
  };

  const downloadTemplate = async () => {
    setError(null);
    try {
      const { blob, fileName } = await apiDownload(`/imports/${entity}/template.xlsx`);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = fileName;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '模板下载失败');
    }
  };

  const preflight = async (file: File) => {
    setBusy(true);
    setError(null);
    setResult(null);
    const form = new FormData();
    form.append('file', file);
    try {
      setResult(await apiPostForm<PreflightResult>(`/imports/${entity}/preflight`, form));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '预检失败，请检查文件');
    } finally {
      setBusy(false);
    }
  };

  const commit = async (event: FormEvent) => {
    event.preventDefault();
    if (!result || result.errorCount > 0) return;
    setBusy(true);
    setError(null);
    try {
      await apiPost(`/imports/${entity}/commit`, { batchId: result.batchId });
      announce(`已导入 ${result.rowCount} 行`);
      onImported();
      onClose();
      reset();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '提交失败，请稍后重试');
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  return createPortal(
    <div className="modal" role="dialog" aria-modal="true" aria-label="Excel 导入">
      <button type="button" className="modal__backdrop" aria-label="关闭" onClick={onClose} />
      <form ref={cardRef} className="modal__card modal__card--wide" onSubmit={(event) => void commit(event)}>
        <p className="eyebrow">BULK IMPORT</p>
        <h2 className="modal__title">Excel 导入</h2>
        <p className="modal__sub">
          先下载模板，填好后上传预检；预检只校验不写库，确认无错误后才整批写入。
        </p>

        <div className="segmented" role="tablist" aria-label="导入对象">
          {ENTITIES.map((item) => (
            <button
              key={item.value}
              type="button"
              role="tab"
              aria-selected={entity === item.value}
              className={`segmented__item${entity === item.value ? ' is-active' : ''}`}
              onClick={() => {
                setEntity(item.value);
                reset();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="exception-dispose__actions">
          <button type="button" className="text-btn" onClick={() => void downloadTemplate()}>
            下载 {ENTITIES.find((item) => item.value === entity)?.label}模板
          </button>
          <label className="btn btn--secondary btn--sm">
            <span className="btn__label">{busy ? '处理中…' : '选择 xlsx 预检'}</span>
            <input
              type="file"
              accept=".xlsx"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void preflight(file);
                event.target.value = '';
              }}
            />
          </label>
        </div>

        {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}

        {result ? (
          <div className="import-result">
            <p className="field__label">
              共 {result.rowCount} 行，{result.errorCount === 0 ? '预检通过' : `${result.errorCount} 个错误`}
            </p>
            {result.errors.length > 0 ? (
              <ul className="import-errors">
                {result.errors.map((issue, index) => (
                  <li key={`${issue.rowNo}-${issue.field}-${index}`} className="import-errors__item">
                    第 {issue.rowNo} 行 · {issue.field}：{issue.message}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="next-step__hint">确认后将在单个事务内写入，任何一行失败都会整批回滚。</p>
            )}
          </div>
        ) : null}

        <div className="modal__actions">
          <Button type="submit" loading={busy} disabled={!result || result.errorCount > 0}>
            确认导入
          </Button>
          <button type="button" className="text-btn" onClick={onClose}>
            取消
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}