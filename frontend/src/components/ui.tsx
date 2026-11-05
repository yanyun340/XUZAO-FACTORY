import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { STATUS_META } from '../lib/format';
import type { OrderStatus } from '../api/types';

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

export function StatusBadge({ status }: { status: OrderStatus }) {
  const meta = STATUS_META[status];
  return (
    <span className={`status status--${meta.tone}`}>
      <span className="status__dot" aria-hidden />
      {meta.label}
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