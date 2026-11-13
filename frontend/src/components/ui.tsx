import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { ACTION_LABEL, STAGE_LABELS, STATUS_META, todayDateInput, type StatusTone } from '../lib/format';
import type { OrderAction, OrderStage, OrderStatus } from '../api/types';

export function Button({
  variant = 'primary',
  loading = false,
  trailing,
  children,
  className = '',
  disabled,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost';
  loading?: boolean;
  trailing?: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`btn btn--${variant} ${className}`.trim()}
      disabled={disabled || loading}
      data-loading={loading || undefined}
      {...props}
    >
      <span className="btn__label">{children}</span>
      {loading ? (
        <span className="btn__spinner" aria-hidden />
      ) : trailing ? (
        <span className="btn__trailing">{trailing}</span>
      ) : null}
    </button>
  );
}

export function StatusBadge({
  status,
  dueDate,
}: {
  status: OrderStatus;
  /** 传入交期后，未完成且已过交期的订单自动转为逾期色。 */
  dueDate?: string;
}) {
  const meta = STATUS_META[status];
  const overdue = status !== 'COMPLETED' && dueDate !== undefined && dueDate < todayDateInput();
  const tone: StatusTone = overdue ? 'overdue' : meta.tone;

  return (
    <span
      className={`status status--${tone}`}
      title={overdue ? `${meta.label} · 已过交期 ${dueDate}` : undefined}
      aria-label={overdue ? `${meta.label}，已逾期` : undefined}
    >
      <span className="status__dot" aria-hidden />
      {meta.label}
    </span>
  );
}

/**
 * 六段工序色带：列表行与待办卡共用同一套格子。
 * 没有工序数据（旧接口）时不渲染，由调用方回退到状态徽章。
 */
export function StageRibbon({
  stages,
  dataLabel,
  className = '',
}: {
  stages: OrderStage[] | undefined;
  /** 窄屏卡片里显示的字段名。 */
  dataLabel?: string;
  className?: string;
}) {
  if (!stages || stages.length === 0) return null;

  return (
    <span className={`order-row__stages stage-ribbon ${className}`.trim()} data-label={dataLabel}>
      {stages.map((stage) => (
        <span
          key={stage.key}
          className="stage-cell"
          data-state={stage.state}
          title={`${STAGE_LABELS[stage.key]} · ${stage.label}`}
        >
          {stage.label}
        </span>
      ))}
    </span>
  );
}

/** 待办卡的主操作：动作名 + 本次数量。数量为 0 时只写动作。 */
export function ActionTag({ action, taskQty }: { action: OrderAction; taskQty: number }) {
  return (
    <span className="action-tag">
      <span className="action-tag__label">{ACTION_LABEL[action]}</span>
      {taskQty > 0 ? (
        <span className="action-tag__qty mono">{taskQty} 件</span>
      ) : null}
    </span>
  );
}

export function Field({
  label,
  htmlFor,
  error,
  hint,
  required,
  children,
  className = '',
}: {
  label: string;
  htmlFor: string;
  error?: string;
  hint?: string;
  required?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`field ${className}`.trim()}>
      <label className="field__label" htmlFor={htmlFor}>
        {label}
        {required ? <span className="field__required">必填</span> : null}
      </label>
      {children}
      {error ? (
        <p className="field__error" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="field__hint">{hint}</p>
      ) : null}
    </div>
  );
}

export function Spinner({ label = '加载中' }: { label?: string }) {
  return (
    <span className="spinner" role="status">
      <span className="spinner__ring" aria-hidden />
      <span className="spinner__label">{label}</span>
    </span>
  );
}

export function LoadingBlock({ lines = 3 }: { lines?: number }) {
  return (
    <div className="skeleton" aria-label="加载中" role="status">
      {Array.from({ length: lines }, (_, index) => (
        <span className="skeleton__line" key={index} style={{ width: `${92 - index * 12}%` }} />
      ))}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty__mark" aria-hidden>
        ∅
      </span>
      <h3 className="empty__title">{title}</h3>
      {description ? <p className="empty__description">{description}</p> : null}
      {action ? <div className="empty__action">{action}</div> : null}
    </div>
  );
}

export function InlineNotice({
  tone = 'error',
  children,
}: {
  tone?: 'error' | 'info';
  children: ReactNode;
}) {
  return (
    <div className={`notice notice--${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      {children}
    </div>
  );
}

export function SectionHeading({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <header className="page-head">
      <div className="page-head__copy">
        <p className="eyebrow">{eyebrow}</p>
        <h1 className="page-title">{title}</h1>
        {description ? <p className="page-lede">{description}</p> : null}
      </div>
      {action ? <div className="page-head__action">{action}</div> : null}
    </header>
  );
}