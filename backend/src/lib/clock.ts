/**
 * R12F：服务端时钟。
 *
 * 撤销窗口（10 分钟）必须能在测试里验证「9分59秒允许、10分01秒拒绝」，
 * 但记录 createdAt 由数据库 now() 生成，因此只把这个「当前时刻」做成可注入，
 * 测试通过偏移派生出的时间点来判断窗口，而不是回填记录的 createdAt。
 */
export const UNDO_WINDOW_MS = 10 * 60_000;

let override: Date | null = null;

/** 当前时刻。生产环境就是 new Date()。 */
export function now(): Date {
  return override ? new Date(override.getTime()) : new Date();
}

/** 仅测试使用；传 null 恢复真实时钟。 */
export function setNowForTesting(date: Date | null): void {
  override = date ? new Date(date.getTime()) : null;
}

/** 记录可否在窗口内撤销：以记录的 createdAt 为基准。 */
export function isWithinUndoWindow(createdAt: Date): boolean {
  return now().getTime() - createdAt.getTime() <= UNDO_WINDOW_MS;
}

/** 窗口截止时刻，给前端倒计时用。 */
export function undoableUntil(createdAt: Date): Date {
  return new Date(createdAt.getTime() + UNDO_WINDOW_MS);
}
