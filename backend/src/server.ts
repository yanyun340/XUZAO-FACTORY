import { buildApp } from './app.ts';
import { config } from './config.ts';
import { disconnectDatabase } from './db.ts';
import { startDueDateReminderJob } from './jobs/scheduler.ts';

const app = buildApp();

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'server.shutting_down');

  try {
    await app.close();
    await disconnectDatabase();
    process.exit(0);
  } catch (error) {
    app.log.error({ err: error }, 'server.shutdown_failed');
    process.exit(1);
  }
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => {
  app.log.error({ err: reason }, 'process.unhandled_rejection');
});
process.on('uncaughtException', (error) => {
  app.log.error({ err: error }, 'process.uncaught_exception');
  void shutdown('uncaughtException');
});

try {
  await app.listen({ host: config.host, port: config.port });
  app.log.info(
    { host: config.host, port: config.port, env: config.nodeEnv },
    'server.started',
  );
} catch (error) {
  app.log.error({ err: error }, 'server.start_failed');
  process.exit(1);
}

// 交期提醒：启动时补跑一次，之后每小时一次；测试环境不启用
if (!config.isTest) {
  startDueDateReminderJob(app.log);
}