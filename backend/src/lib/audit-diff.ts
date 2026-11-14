/**
 * 审计前后值差异（R23F）。
 * 只比较第一层字段：本项目的审计 payload 都是扁平对象；嵌套对象整体比较。
 */
const SENSITIVE_KEY = /(password|token|hash|secret|connection|dsn|cookie)/i;
const MASK = '***';

export interface AuditChange {
  field: string;
  before: unknown;
  after: unknown;
}

type RecordLike = Record<string, unknown>;

function asRecord(value: unknown): RecordLike | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as RecordLike;
}

/** 敏感字段一律替换为 ***，导出和页面都不出现原文。 */
export function maskValue(field: string, value: unknown): unknown {
  if (SENSITIVE_KEY.test(field)) return MASK;
  return value ?? null;
}

export function maskRecord(value: unknown): RecordLike | null {
  const record = asRecord(value);
  if (!record) return null;
  const masked: RecordLike = {};
  for (const [field, fieldValue] of Object.entries(record)) {
    masked[field] = maskValue(field, fieldValue);
  }
  return masked;
}

export function diffRecords(before: unknown, after: unknown): AuditChange[] {
  const beforeRecord = asRecord(before);
  const afterRecord = asRecord(after);
  if (!beforeRecord && !afterRecord) return [];

  const fields = new Set([
    ...Object.keys(beforeRecord ?? {}),
    ...Object.keys(afterRecord ?? {}),
  ]);

  const changes: AuditChange[] = [];
  for (const field of [...fields].sort()) {
    const previous = beforeRecord?.[field];
    const next = afterRecord?.[field];
    if (JSON.stringify(previous) === JSON.stringify(next)) continue;
    changes.push({
      field,
      before: maskValue(field, previous),
      after: maskValue(field, next),
    });
  }
  return changes;
}

/** xlsx / 页面共用的单行摘要，避免把整段 JSON 塞进单元格。 */
export function formatChanges(changes: AuditChange[]): string {
  return changes
    .map((change) => {
      const before = change.before === null || change.before === undefined ? '空' : String(change.before);
      const after = change.after === null || change.after === undefined ? '空' : String(change.after);
      return `${change.field}: ${before} → ${after}`;
    })
    .join('；');
}