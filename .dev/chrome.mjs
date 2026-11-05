// `pnpm dev`: 只调试 Chrome; 需要 Edge 时手敲 `pnpm wxt -b edge` (端口自己加 -p)。
// 脚本只补 wxt 做不到的两件事:
// - 固定 dev server 端口: 换端口后已加载的 dev 扩展还连旧地址, 热更新与重载都会失效
// - 常驻监听调试端口, 把 dev 扩展固定到工具栏: 未打包扩展的固定状态只在内存里, 每次重载都会丢

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { watchDevExtensionPin } from './pin-dev-extension.mjs';

// 与 wxt.config.ts 的端口约定一致: Chrome 3001, Firefox 3000 (`pnpm dev:firefox` 用默认值)
const DEV_SERVER_PORT = 3001;
// 与 wxt.config.ts 的 CDP_PORTS.chrome 一致, pin 脚本靠它连浏览器
const DEBUG_PORT = 9222;

// 直接 `node .dev/dev.mjs` 运行时 PATH 里没有 node_modules/.bin, 优先用本地 wxt
const localWxt = resolve('node_modules/.bin/wxt' + (process.platform === 'win32' ? '.cmd' : ''));

// 继承 stdio: 父进程不转发日志, wxt 自带的 o 键重启与交互继续可用;
// 浏览器路径交给 wxt 自己探测, 装在不常见位置时用 CHROME_BINARY 覆盖 (wxt.config.ts 会读)
const wxt = spawn(existsSync(localWxt) ? localWxt : 'wxt', ['-b', 'chrome', '-p', String(DEV_SERVER_PORT)], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

const stopWatching = watchDevExtensionPin({
  targets: [{ port: DEBUG_PORT, extensionDir: resolve('.output/chrome-mv3-dev'), label: 'chrome' }],
});

// 等 close 才往下走: 只发 SIGTERM 就退出的话, wxt 可能还没退干净就交还了终端
function stopChild() {
  if (wxt.exitCode !== null || wxt.signalCode !== null) return Promise.resolve();
  return new Promise(done => {
    wxt.once('close', done);
    wxt.kill('SIGTERM');
    // 兜底: wxt 不响应 SIGTERM 时也别让终端一直挂着
    setTimeout(done, 3000).unref();
  });
}

let stopping = false;
async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  stopWatching();
  await stopChild();
  process.exit(code);
}

wxt.on('close', code => shutdown(code ?? 0));
wxt.on('error', error => {
  console.error(`✖ 启动 wxt 失败: ${error.message}`);
  shutdown(1);
});

// Ctrl+C / 被 kill 时连 wxt 一起收尾, 避免留下孤儿进程继续占端口
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => shutdown(0));
