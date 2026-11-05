/**
 * 危险操作：删除本地嵌入式 PostgreSQL 的全部数据并重新初始化。
 * 只作用于项目数据目录，不触碰任何外部数据库。
 *
 * 用法：先停止 npm run db，再执行
 *   XUZAO_DB_RESET=1 npm run db:reset
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir =
  process.env.XUZAO_PGDATA ?? path.join(os.homedir(), '.xuzao', 'pgdata');

if (process.env.XUZAO_DB_RESET !== '1') {
  console.error('[db:reset] 已取消：请设置 XUZAO_DB_RESET=1 明确确认。');
  console.error(`[db:reset] 将要删除：${dataDir}`);
  process.exit(1);
}

if (!dataDir.includes('.xuzao')) {
  console.error(`[db:reset] 拒绝删除非项目默认目录：${dataDir}`);
  process.exit(1);
}

fs.rmSync(dataDir, { recursive: true, force: true });
console.log(`[db:reset] 已删除 ${dataDir}`);
console.log('[db:reset] 下次运行 npm run db 会重新初始化。');