import type { FastifyBaseLogger } from 'fastify';
import { runDueDateReminders } from './due-reminders.ts';

const HOUR = 60 * 60 * 1000;

/**
 * 每小时跑一次交期提醒，进程启动时先补跑一次。
 * 任务本身按业务日期去重，重复执行只会返回 created: 0。
 */
export function startDueDateReminderJob(log: FastifyBaseLogger, intervalMs = HOUR): () => void {
  let running = false;

  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const result = await runDueDateReminders();
      if (result.created > 0) log.info(result, 'reminders.due_date.created');
    } catch (error) {
      log.error({ err: error }, 'reminders.due_date.failed');
    } finally {
      running = false;
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();

  return () => clearInterval(timer);
}