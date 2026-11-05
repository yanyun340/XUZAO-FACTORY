/**
 * 启动项目内嵌的 PostgreSQL（真实 Postgres 二进制，无需管理员权限）。
 *
 * 为什么要把二进制复制到用户目录：
 * 项目路径含中文时，Windows 版 initdb 会把 GBK 路径写进 UTF-8 数据库并失败。
 * 因此这里把二进制复制到 %USERPROFILE%\.xuzao\pgsql（纯 ASCII）再启动。
 *
 * 用法：npm run db
 * 环境变量：XUZAO_PG_PORT、XUZAO_PGDATA
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from 'pg';

const PORT = Number(process.env.XUZAO_PG_PORT ?? 55432);
const HOME_DIR = path.join(os.homedir(), '.xuzao');
const DATA_DIR =
  process.env.XUZAO_PGDATA ?? path.join(HOME_DIR, 'pgdata');
const PG_HOME = path.join(HOME_DIR, 'pgsql');
const BIN_DIR = path.join(PG_HOME, 'bin');
const LOG_FILE = path.join(HOME_DIR, 'pg.log');
const USER = 'postgres';
const PASSWORD = 'postgres';
const DATABASES = ['xuzao_dev', 'xuzao_test'];

function decode(buffer) {
  if (!buffer) return '';
  const utf8 = new TextDecoder('utf-8').decode(buffer);
  if (!utf8.includes('�')) return utf8;
  return new TextDecoder('gbk').decode(buffer);
}

function run(exe, args) {
  const result = spawnSync(path.join(BIN_DIR, exe), args, {
    encoding: 'buffer',
    env: { ...process.env, LANG: 'C', LC_ALL: 'C' },
    windowsHide: true,
  });
  if (result.status !== 0) {
    const detail = decode(result.stderr) || decode(result.stdout) || String(result.error);
    throw new Error(`${exe} 执行失败：${detail.trim()}`);
  }
  return decode(result.stdout);
}

function ensureBinaries() {
  if (fs.existsSync(path.join(BIN_DIR, 'initdb.exe'))) return;
  const source = path.resolve(
    'node_modules/@embedded-postgres/windows-x64/native'
  );
  if (!fs.existsSync(source)) {
    throw new Error(
      '找不到 PostgreSQL 二进制。请先在项目根目录执行 npm install。'
    );
  }
  console.log(`[db] 正在复制 PostgreSQL 二进制到 ${PG_HOME}（约 108MB，只需一次）`);
  fs.cpSync(source, PG_HOME, { recursive: true });
}

function initialiseIfNeeded() {
  if (fs.existsSync(path.join(DATA_DIR, 'PG_VERSION'))) return;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const pwfile = path.join(os.tmpdir(), `xuzao-pg-${process.pid}.txt`);
  fs.writeFileSync(pwfile, `${PASSWORD}\n`, 'utf8');
  try {
    console.log(`[db] 初始化数据目录：${DATA_DIR}`);
    run('initdb.exe', [
      '-D', DATA_DIR,
      '-U', USER,
      '--encoding=UTF8',
      '--locale=C',
      '--auth=scram-sha-256',
      `--pwfile=${pwfile}`,
    ]);
  } finally {
    fs.rmSync(pwfile, { force: true });
  }
}

function startServer() {
  console.log(`[db] 启动 PostgreSQL：127.0.0.1:${PORT}`);
  run('pg_ctl.exe', [
    '-D', DATA_DIR,
    '-l', LOG_FILE,
    '-o', `-p ${PORT} -c listen_addresses=127.0.0.1`,
    'start',
    '-w',
    '-t', '60',
  ]);
}

async function ensureDatabases() {
  const client = new Client({
    host: '127.0.0.1',
    port: PORT,
    user: USER,
    password: PASSWORD,
    database: 'postgres',
  });
  await client.connect();
  try {
    for (const name of DATABASES) {
      const existing = await client.query(
        'SELECT 1 FROM pg_database WHERE datname = $1',
        [name]
      );
      if (existing.rowCount === 0) {
        await client.query(`CREATE DATABASE "${name}"`);
        console.log(`[db] 已创建数据库 ${name}`);
      } else {
        console.log(`[db] 数据库已存在：${name}`);
      }
    }
  } finally {
    await client.end();
  }
}

function stopServer() {
  spawnSync(path.join(BIN_DIR, 'pg_ctl.exe'), [
    '-D', DATA_DIR,
    'stop',
    '-m', 'fast',
    '-w',
    '-t', '30',
  ], { encoding: 'buffer', windowsHide: true });
}

try {
  ensureBinaries();
  initialiseIfNeeded();
  startServer();
  await ensureDatabases();
  console.log('[db] PostgreSQL 已就绪');
  console.log('[db] 按 Ctrl+C 停止');
} catch (error) {
  console.error(`[db] 启动失败：${error instanceof Error ? error.message : error}`);
  if (fs.existsSync(LOG_FILE)) {
    console.error(`[db] 日志：${LOG_FILE}`);
  }
  process.exit(1);
}

let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  console.log('\n[db] 正在停止 PostgreSQL...');
  stopServer();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// 保持进程存活，让 Postgres 服务持续运行
await new Promise(() => {});