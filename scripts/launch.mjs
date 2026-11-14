// 一键启动开发栈：起 npm run dev，等 5173 通了再打开浏览器。
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const URL = 'http://localhost:5173';

async function probe() {
  try {
    const res = await fetch(URL, { signal: AbortSignal.timeout(2000) });
    return res.status;
  } catch {
    return 0;
  }
}

function openBrowser() {
  spawn('cmd', ['/c', 'start', '', URL], { detached: true, stdio: 'ignore' }).unref();
}

// 已经在跑就直接开页面，避免二次启动把端口挤到 5174
if (await probe()) {
  console.log(`\n[launch] ${URL} 已在运行，直接打开浏览器。`);
  openBrowser();
  process.exit(0);
}

console.log('[launch] 启动 db:55432 → api:3001 → web:5173 …\n');
const child = spawn('npm', ['run', 'dev'], { stdio: 'inherit', shell: true });

let stopped = false;
const stop = (sig) => {
  if (stopped) return;
  stopped = true;
  try { child.kill(sig); } catch {}
};
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));

(async () => {
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) return; // dev 挂了，别再等
    const status = await probe();
    if (status && status < 500) {
      console.log(`\n[launch] 就绪：${URL}  — 已为你打开浏览器\n`);
      openBrowser();
      return;
    }
    await sleep(1500);
  }
  console.log(`\n[launch] 等待 ${URL} 超时（3 分钟），请看上面的报错。`);
})();

child.on('exit', (code) => process.exit(code ?? 0));