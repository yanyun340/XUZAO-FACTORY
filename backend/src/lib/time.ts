const SHANGHAI = 'Asia/Shanghai';

/** 北京时间自然日 YYYY-MM-DD，用于订单号与交期提醒。 */
export function shanghaiDateKey(date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: SHANGHAI,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Prisma 的 @db.Date 以 UTC 零点返回，直接截取日期部分即可。 */
export function toDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** 把 YYYY-MM-DD 解析为 UTC 零点，配合 @db.Date 使用。 */
export function parseDateOnly(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

export function isDateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = parseDateOnly(value);
  return !Number.isNaN(parsed.getTime()) && toDateOnly(parsed) === value;
}

export function nowIso(): string {
  return new Date().toISOString();
}