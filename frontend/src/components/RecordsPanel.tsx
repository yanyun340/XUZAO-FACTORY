import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ApiError, apiPost } from '../api/client';
import type { OrderDetail, UndoMeta, VoidMeta } from '../api/types';
import { useModalFocus } from '../hooks/useModalFocus';
import { useExitClose } from '../hooks/useExitClose';
import { formatDateTime } from '../lib/format';
import { toast } from './Toast';
import { Button, InlineNotice } from './ui';

/**
 * R12F：10 分钟撤销窗口的倒计时。
 *
 * 起点用服务端给的 remainingMs（毫秒），本地只做递减，
 * 不用客户端时钟去减绝对时间——现场机器时间不准时倒计时会偏。
 * 只负责显示；「能不能撤」由服务端在 DTO 里算好（undo.canUndo），
 * 倒计时到期后按钮变灰，真正的拦截仍在后端。
 */
function useCountdown(remainingMs: number | null): string | null {
  const [left, setLeft] = useState(remainingMs);

  useEffect(() => {
    setLeft(remainingMs);
    if (remainingMs === null || remainingMs <= 0) return;
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      const next = remainingMs - (Date.now() - startedAt);
      setLeft(next > 0 ? next : 0);
      if (next <= 0) window.clearInterval(timer);
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [remainingMs]);

  if (left === null || left <= 0) return null;
  const totalSeconds = Math.ceil(left / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

interface RecordRow {
  /** 唯一键，用于列表 key 与幂等键。 */
  key: string;
  /** 记录 ID，用于拼撤销/修正路径。 */
  id: string;
  /** 记录类型，与后端路由前缀一致。 */
  kind: 'arrivals' | 'feedbacks' | 'qc-records' | 'packing-records' | 'shipment-records';
  label: string;
  quantityText: string;
  operatorName: string;
  createdAt: string;
  voidMeta: VoidMeta;
  undo: UndoMeta;
}

function toRow(
  kind: RecordRow['kind'],
  label: string,
  quantityText: string,
  record: {
    id: string;
    operatorName: string;
    createdAt: string;
  } & VoidMeta & { undo: UndoMeta },
): RecordRow {
  return {
    key: `${kind}:${record.id}`,
    id: record.id,
    kind,
    label,
    quantityText,
    operatorName: record.operatorName,
    createdAt: record.createdAt,
    voidMeta: {
      voidedAt: record.voidedAt,
      voidReason: record.voidReason,
      voidedByName: record.voidedByName,
    },
    undo: record.undo,
  };
}

/** 把订单详情的五类记录摊平成行，保持发生顺序。 */
function collectRows(order: OrderDetail): RecordRow[] {
  const rows: RecordRow[] = [];

  for (const item of order.flow.purchase?.items ?? []) {
    for (const arrival of item.arrivals) {
      rows.push(toRow('arrivals', '到货', `${arrival.quantity} 件`, arrival));
    }
  }

  const feedback = order.flow.production?.feedback;
  if (feedback) {
    rows.push(toRow('feedbacks', '生产反馈', `${feedback.quantity} 件`, feedback));
  }

  for (const record of order.flow.qc?.records ?? []) {
    rows.push(
      toRow(
        'qc-records',
        `质检 · 第 ${record.round} 轮`,
        `检验 ${record.inspectedQty} · 合格 ${record.qualifiedQty}`,
        record,
      ),
    );
  }

  for (const record of order.flow.packing.records) {
    rows.push(toRow('packing-records', '包装', `${record.quantity} 件`, record));
  }

  for (const record of order.flow.shipping.records) {
    rows.push(toRow('shipment-records', '发货', `${record.quantity} 件`, record));
  }

  return rows.sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
}

function RecordLine({
  row,
  busy,
  onUndo,
  onCorrect,
}: {
  row: RecordRow;
  busy: boolean;
  onUndo: (row: RecordRow) => void;
  onCorrect: (row: RecordRow) => void;
}) {
  const countdown = useCountdown(row.undo.canUndo ? row.undo.remainingMs : null);
  const voided = row.voidMeta.voidedAt !== null;

  return (
    <li className={`record-item${voided ? ' record-item--voided' : ''}`}>
      <span className="record-item__main">
        <span className="record-item__kind">{row.label}</span>
        <span className="record-item__qty mono">{row.quantityText}</span>
      </span>
      <span className="record-item__meta mono">
        {row.operatorName} · {formatDateTime(row.createdAt)}
      </span>
      {voided ? (
        <span
          className="record-item__void mono"
          title={row.voidMeta.voidReason ?? undefined}
        >
          已作废{row.voidMeta.voidedByName ? ` · ${row.voidMeta.voidedByName}` : ''}
          {row.voidMeta.voidReason ? ` · ${row.voidMeta.voidReason}` : ''}
        </span>
      ) : row.undo.canUndo ? (
        <span className="record-item__actions">
          {countdown ? <span className="record-item__timer mono">{countdown}</span> : null}
          <button
            type="button"
            className="text-btn text-btn--danger"
            disabled={busy}
            onClick={() => onUndo(row)}
          >
            撤销
          </button>
        </span>
      ) : row.undo.canCorrect ? (
        <span className="record-item__actions">
          <button
            type="button"
            className="text-btn text-btn--danger"
            disabled={busy}
            onClick={() => onCorrect(row)}
          >
            修正
          </button>
        </span>
      ) : (
        <span className="record-item__meta">超出撤销窗口</span>
      )}
    </li>
  );
}

/** 管理员修正：必填原因，2–200 字。 */
function CorrectDialog({
  row,
  onClose,
  onDone,
}: {
  row: RecordRow;
  onClose: () => void;
  onDone: (detail: OrderDetail) => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { leaving, requestClose } = useExitClose(onClose);
  const cardRef = useModalFocus(true, requestClose, { canClose: () => !busy });
  // 同一意图重试复用同一个幂等键。
  const keyRef = useRef('');

  const trimmed = reason.trim();
  const valid = trimmed.length >= 2 && trimmed.length <= 200;

  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      if (!keyRef.current) keyRef.current = crypto.randomUUID();
      const detail = await apiPost<OrderDetail>(
        `/${row.kind}/${row.id}/correct`,
        { reason: trimmed },
        { 'Idempotency-Key': keyRef.current },
      );
      keyRef.current = '';
      onDone(detail);
      toast(`${row.label}记录已修正`);
      onClose();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '修正失败，请稍后重试');
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div className={`modal${leaving ? ' modal--leaving' : ''}`} role="dialog" aria-modal="true" aria-labelledby="correct-title">
      <button type="button" className="modal__backdrop" aria-label="关闭" onClick={requestClose} />
      <form
        className="modal__card"
        ref={cardRef}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <h2 className="modal__title" id="correct-title">
          修正{row.label}记录
        </h2>
        <p className="modal__sub">
          {row.quantityText} · {row.operatorName} · {formatDateTime(row.createdAt)}
          。修正后记录标记作废、不计入数量，并写入时间线与审计。
        </p>
        <label className="field">
          <span className="field__label">修正原因</span>
          <textarea
            className="input input--textarea"
            rows={3}
            maxLength={200}
            data-autofocus
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="例如：现场录错，实际到货 80 件"
          />
          <span className="field__hint">{trimmed.length} / 200</span>
        </label>
        {error ? <p className="field__error" role="alert">{error}</p> : null}
        <div className="modal__actions">
          <button type="button" className="btn btn--secondary" onClick={requestClose} disabled={busy}>
            <span className="btn__label">取消</span>
          </button>
          <Button type="submit" loading={busy} disabled={!valid}>
            确认修正
          </Button>
        </div>
      </form>
    </div>,
    document.body,
  );
}

/**
 * R12F：录入记录台账。
 *
 * 五类记录（到货 / 生产反馈 / 质检 / 包装 / 发货）按发生顺序列出，
 * 每条都可看到录入人、时间、是否作废；窗口内显示倒计时并可撤销。
 */
export function RecordsPanel({
  order,
  onUpdated,
}: {
  order: OrderDetail;
  onUpdated: (detail: OrderDetail) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [correcting, setCorrecting] = useState<RecordRow | null>(null);
  const keysRef = useRef<Record<string, string>>({});

  const rows = collectRows(order);
  if (rows.length === 0) return null;

  const undo = async (row: RecordRow) => {
    setBusy(true);
    setError(null);
    try {
      if (!keysRef.current[row.key]) keysRef.current[row.key] = crypto.randomUUID();
      const detail = await apiPost<OrderDetail>(
        `/${row.kind}/${row.id}/undo`,
        {},
        { 'Idempotency-Key': keysRef.current[row.key] },
      );
      delete keysRef.current[row.key];
      onUpdated(detail);
      toast(`${row.label}记录已撤销`);
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'UNDO_WINDOW_EXPIRED') {
        setError('已超过 10 分钟撤销窗口，请由管理员修正');
      } else if (caught instanceof ApiError) {
        setError(caught.message);
      } else {
        setError('撤销失败，请稍后重试');
      }
    } finally {
      setBusy(false);
    }
  };

  const voidedCount = rows.filter((row) => row.voidMeta.voidedAt !== null).length;

  return (
    <section className="record-panel">
      <div className="record-panel__head">
        <h2 className="panel__title">录入记录</h2>
        <span className="record-panel__count mono">
          {rows.length} 条{voidedCount > 0 ? ` · ${voidedCount} 条已作废` : ''}
        </span>
      </div>
      {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}
      <ul className="record-list">
        {rows.map((row) => (
          <RecordLine
            key={row.key}
            row={row}
            busy={busy}
            onUndo={(target) => void undo(target)}
            onCorrect={(target) => setCorrecting(target)}
          />
        ))}
      </ul>
      {correcting ? (
        <CorrectDialog
          row={correcting}
          onClose={() => setCorrecting(null)}
          onDone={onUpdated}
        />
      ) : null}
    </section>
  );
}
