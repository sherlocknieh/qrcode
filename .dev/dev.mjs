// dev 入口:
// - `pnpm dev`                     → 同时启动 Chrome/Edge/Firefox, 没装的浏览器静默跳过
// - `pnpm dev:chrome|edge|firefox` → 只启动指定浏览器, 没装则报错退出
// 启动的同时会把 Chromium 系浏览器的 dev 扩展自动固定到工具栏.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import readline from 'node:readline';
import { watchDevExtensionPin } from './pin-dev-extension.mjs';

const ALL_BROWSERS = ['chrome', 'edge', 'firefox'];
const DEV_SERVER_PORTS = { chrome: 3000, edge: 3001, firefox: 3002 };
const DEBUG_PORTS = { chrome: 9222, edge: 9223 }; // Firefox 没有 CDP, 不支持自动固定图标

const BINARY_ENV = { chrome: 'CHROME_BINARY', edge: 'EDGE_BINARY', firefox: 'FIREFOX_BINARY' };
const PATH_NAMES = {
  chrome: ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'],
  edge: ['microsoft-edge', 'microsoft-edge-stable', 'msedge'],
  firefox: ['firefox', 'firefox-esr'],
};

const args = process.argv.slice(2);

// 直接 `node .dev/dev.mjs` 运行时 PATH 里没有 node_modules/.bin, 优先用本地 wxt
const localWxt = resolve('node_modules/.bin/wxt' + (process.platform === 'win32' ? '.cmd' : ''));
const WXT_COMMAND = existsSync(localWxt) ? localWxt : 'wxt';

const children = new Map();
const launched = new Map(); // browser -> 启动参数, 供重启复用
let exitCode = 0;
let shuttingDown = false;
let restarting = false;
let stopWatching = () => {};

function readBrowser() {
  const inline = args.find(arg => arg.startsWith('--browser='));
  if (inline) return inline.slice('--browser='.length);
  const index = args.findIndex(arg => arg === '-b' || arg === '--browser');
  return index >= 0 && args[index + 1] ? args[index + 1] : null;
}

function withoutBrowserArgs() {
  return args.filter((arg, index) => {
    if (arg === '-b' || arg === '--browser') return false;
    const previous = args[index - 1];
    return previous !== '-b' && previous !== '--browser';
  });
}

// 用户显式传了端口就尊重用户, 否则用按浏览器固定的端口
function hasPortArg(list) {
  return list.some(arg => arg === '-p' || arg === '--port' || arg.startsWith('--port='));
}

function knownBinaryPaths(browser) {
  const env = process.env;
  if (process.platform === 'win32') {
    const map = {
      chrome: [
        env.ProgramFiles && `${env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
        env['ProgramFiles(x86)'] && `${env['ProgramFiles(x86)']}\\Google\\Chrome\\Application\\chrome.exe`,
        env.LOCALAPPDATA && `${env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
      ],
      edge: [
        env['ProgramFiles(x86)'] && `${env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
        env.ProgramFiles && `${env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
        env.LOCALAPPDATA && `${env.LOCALAPPDATA}\\Microsoft\\Edge\\Application\\msedge.exe`,
      ],
      firefox: [
        env.ProgramFiles && `${env.ProgramFiles}\\Mozilla Firefox\\firefox.exe`,
        env['ProgramFiles(x86)'] && `${env['ProgramFiles(x86)']}\\Mozilla Firefox\\firefox.exe`,
      ],
    };
    return map[browser].filter(Boolean);
  }

  if (process.platform === 'darwin') {
    return {
      chrome: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
      edge: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
      firefox: ['/Applications/Firefox.app/Contents/MacOS/firefox'],
    }[browser];
  }

  return {
    chrome: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'],
    edge: ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable', '/opt/microsoft/msedge/msedge'],
    firefox: ['/usr/bin/firefox', '/usr/bin/firefox-esr'],
  }[browser];
}

function onPath(names) {
  const lookup = process.platform === 'win32' ? 'where' : 'which';
  return names.some(name => spawnSync(lookup, [name], { stdio: 'ignore' }).status === 0);
}

/**
 * 返回可执行文件绝对路径; 装好了但交给浏览器自身默认探测即可时返回空字符串; 没装返回 null.
 */
function resolveBrowserBinary(browser) {
  const override = process.env[BINARY_ENV[browser]];
  if (override) return override;

  const found = knownBinaryPaths(browser).find(path => existsSync(path));
  if (found) return found;

  return onPath(PATH_NAMES[browser]) ? '' : null;
}

function buildEnv(browser, binary) {
  const env = { ...process.env, WXT_DEV_BROWSER: browser };
  if (DEBUG_PORTS[browser]) env.WXT_DEV_CDP_PORT = String(DEBUG_PORTS[browser]);
  if (binary) env[`WXT_DEV_${browser.toUpperCase()}_BINARY`] = binary;
  return env;
}

function spawnWxt(browser, wxtArgs, { interactive }) {
  const child = spawn(WXT_COMMAND, wxtArgs, {
    stdio: interactive ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
    env: buildEnv(browser, resolveBrowserBinary(browser) ?? ''),
  });
  children.set(browser, child);

  if (!interactive) {
    const prefix = `[${browser}] `;
    for (const stream of [child.stdout, child.stderr]) {
      readline.createInterface({ input: stream }).on('line', line => {
        process.stdout.write(`${prefix}${line}\n`);
      });
    }
  }

  child.on('error', error => {
    console.error(`[${browser}] 启动失败: ${error.message}`);
  });

  launched.set(browser, { args: wxtArgs, interactive });
  // 用 close 而不是 exit: 启动失败(ENOENT 等)时只会有 close
  child.on('close', code => {
    children.delete(browser);
    if (shuttingDown || restarting) return;
    if (code) exitCode = code;
    // 多浏览器模式下等所有子进程退出; 单浏览器模式自然只剩一个
    if (children.size === 0) process.exit(exitCode);
  });
}

// 多进程模式下子进程拿不到 TTY, wxt 自带的 o + enter 不生效, 由父进程接管
function restartAll() {
  if (restarting || shuttingDown) return;
  restarting = true;
  console.log('ℹ 重新打开浏览器...');

  const records = [...launched.entries()];
  let pending = records.length;
  const done = () => {
    if (--pending > 0) return;
    restarting = false;
    for (const [browser, record] of records) {
      if (shuttingDown) return;
      spawnWxt(browser, record.args, { interactive: record.interactive });
    }
  };

  for (const [browser] of records) {
    const child = children.get(browser);
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      done();
      continue;
    }
    child.once('close', done);
    child.kill('SIGTERM');
  }
  if (records.length === 0) restarting = false;
}

function listenShortcuts() {
  if (!process.stdin.isTTY) return;
  readline.createInterface({ input: process.stdin }).on('line', line => {
    if (line.trim() === 'o') restartAll();
  });
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  stopWatching();
  for (const child of children.values()) {
    if (!child.killed) child.kill(signal);
  }
  setTimeout(() => process.exit(exitCode), 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

const explicitBrowser = readBrowser();

if (explicitBrowser) {
  if (!ALL_BROWSERS.includes(explicitBrowser)) {
    console.error(`✖ 不支持的浏览器: ${explicitBrowser}, 可选: ${ALL_BROWSERS.join(' / ')}`);
    process.exit(1);
  }

  const binary = resolveBrowserBinary(explicitBrowser);
  if (binary === null) {
    console.error(`✖ 未找到 ${explicitBrowser}, 请先安装, 或用环境变量 ${BINARY_ENV[explicitBrowser]} 指定可执行文件路径`);
    process.exit(1);
  }

  console.log(`ℹ 使用 ${explicitBrowser}${binary ? `: ${binary}` : ''}`);
  // 单浏览器模式也用与 `pnpm dev` 相同的固定端口, 否则同一浏览器两次启动端口不同,
  // 已加载的 dev 扩展会连不上新端口 (热更新/重载失效)
  const wxtArgs = hasPortArg(args)
    ? args
    : ['-p', String(DEV_SERVER_PORTS[explicitBrowser]), ...args];
  spawnWxt(explicitBrowser, wxtArgs, { interactive: true });

  const port = DEBUG_PORTS[explicitBrowser];
  if (port) {
    stopWatching = watchDevExtensionPin({
      targets: [{ port, extensionDir: resolve(`.output/${explicitBrowser}-mv3-dev`), label: explicitBrowser }],
    });
  }
} else {
  const started = [];

  for (const browser of ALL_BROWSERS) {
    if (resolveBrowserBinary(browser) === null) continue; // 没装就静默跳过

    const wxtArgs = ['-b', browser, '-p', String(DEV_SERVER_PORTS[browser]), ...withoutBrowserArgs()];
    if (browser === 'firefox') wxtArgs.push('--mv3');
    spawnWxt(browser, wxtArgs, { interactive: false });
    started.push(browser);
  }

  if (started.length === 0) {
    console.error('✖ 没有找到任何可用的浏览器, 请先安装 Chrome / Edge / Firefox');
    process.exit(1);
  }

  console.log(`ℹ 同时调试: ${started.join(' / ')}`);
  console.log('ℹ 输入 o + enter 可重新打开所有浏览器');
  listenShortcuts();
  stopWatching = watchDevExtensionPin({
    targets: started
      .filter(browser => DEBUG_PORTS[browser])
      .map(browser => ({
        port: DEBUG_PORTS[browser],
        extensionDir: resolve(`.output/${browser}-mv3-dev`),
        label: browser,
      })),
  });
}
