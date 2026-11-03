// 让 Chromium 系浏览器(Chrome/Edge)把 dev 扩展固定在工具栏.
// 磁盘上的 Preferences(extensions.pinned_extensions) 对 CDP 加载的未打包扩展无效,
// 唯一入口是 chrome://extensions 页面里的 chrome.developerPrivate 私有 API,
// 所以这里通过 --remote-debugging-port 连上去, 在页面上下文里调用它.
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const OUTPUT_DIR = resolve('.output');

// Chrome 对未打包扩展用路径的 sha256 前 16 字节生成 id, 每位 0-f 映射到 a-p
function extensionIdForPath(dir) {
  const hex = createHash('sha256').update(dir).digest('hex').slice(0, 32);
  return [...hex].map(char => String.fromCharCode(97 + parseInt(char, 16))).join('');
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// 该函数会被序列化后放进 chrome://extensions 页面执行, 不能引用闭包变量.
async function pinInPage(outputDir) {
  const normalize = value =>
    String(value ?? '')
      .replace(/[\\/]+$/, '')
      .replace(/\\/g, '/')
      .toLowerCase();

  const profile = await chrome.developerPrivate.getProfileConfiguration();
  if (profile && profile.inDeveloperMode === false) {
    await chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }).catch(() => {});
  }

  const extensions = await chrome.developerPrivate.getExtensionsInfo();
  const devExtensions = extensions.filter(
    ext =>
      ext.location === 'UNPACKED' &&
      normalize(ext.path).startsWith(`${normalize(outputDir)}/`) &&
      normalize(ext.path).endsWith('-dev'),
  );
  if (devExtensions.length === 0) return 'not-loaded';

  let pinned = 0;
  for (const ext of devExtensions) {
    if (ext.pinnedToToolbar) continue;
    await chrome.developerPrivate.updateExtensionConfiguration({
      extensionId: ext.id,
      pinnedToToolbar: true,
    });
    pinned += 1;
  }
  return pinned > 0 ? 'pinned' : 'already-pinned';
}

async function request(port, path, timeout = 1000) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// 只为执行一条命令而临时建立连接, 用完即关
async function sendCommand(wsUrl, method, params) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('无法连接 Chrome 调试端口'));
  });

  try {
    return await new Promise((resolve, reject) => {
      ws.onmessage = event => {
        const message = JSON.parse(event.data);
        if (message.id !== 1) return;
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      };
      ws.send(JSON.stringify({ id: 1, method, params }));
    });
  } finally {
    ws.close();
  }
}

async function evaluate(wsUrl, expression) {
  const result = await sendCommand(wsUrl, 'Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  return result?.result?.value;
}

async function createBackgroundExtensionsPage(port) {
  const { webSocketDebuggerUrl } = await request(port, '/json/version');
  const { targetId } = await sendCommand(webSocketDebuggerUrl, 'Target.createTarget', {
    url: 'chrome://extensions',
    background: true, // 后台开标签, 不抢焦点
  });
  if (!targetId) throw new Error('创建 chrome://extensions 标签失败');

  for (let i = 0; i < 20; i++) {
    const page = (await request(port, '/json/list')).find(target => target.id === targetId);
    if (page) return page;
    await sleep(100);
  }
  throw new Error('chrome://extensions 页面未就绪');
}

async function pinOnce(port) {
  const isExtensionsPage = url => /^(chrome|edge):\/\/extensions/.test(String(url ?? ''));
  const targets = await request(port, '/json/list');
  const existing = targets.find(target => target.type === 'page' && isExtensionsPage(target.url));
  const page = existing ?? (await createBackgroundExtensionsPage(port));

  try {
    const status = await evaluate(page.webSocketDebuggerUrl, `(${pinInPage})(${JSON.stringify(OUTPUT_DIR)})`);
    return { done: status === 'pinned' || status === 'already-pinned', status };
  } finally {
    // 临时标签页用完就关掉, 避免多出一个 chrome://extensions 标签
    if (!existing) await request(port, `/json/close/${page.id}`).catch(() => {});
  }
}

function watchOne({ port, extensionDir, label }, log) {
  const expectedId = extensionIdForPath(extensionDir);
  let stopped = false;
  let pinnedSession = null;
  let session = null;
  let sessionStart = 0;

  (async () => {
    while (!stopped) {
      try {
        const version = await request(port, '/json/version');
        const currentSession = version?.webSocketDebuggerUrl;
        if (!currentSession) throw new Error('调试端口未就绪');

        if (currentSession !== session) {
          session = currentSession;
          sessionStart = Date.now();
        }

        if (pinnedSession !== session) {
          const targets = await request(port, '/json/list');
          const loaded = targets.some(target =>
            String(target.url ?? '').includes(`chrome-extension://${expectedId}`),
          );
          // 扩展还没加载时不开标签探测, 否则会反复闪现 chrome://extensions; 超时后仍兜底试一次
          if (loaded || Date.now() - sessionStart > 20000) {
            const { done, status } = await pinOnce(port);
            if (done) {
              pinnedSession = session;
              const prefix = label ? `[${label}] ` : '';
              log(`${prefix}${status === 'pinned' ? '✔ 已自动固定工具栏图标' : '✔ 工具栏图标已处于固定状态'}`);
            }
          }
        }
      } catch {
        // 浏览器还没启动或已关闭, 继续等
      }
      await sleep(800);
    }
  })();

  return () => {
    stopped = true;
  };
}

/**
 * 等待 dev 浏览器(可多个), 扩展加载后固定一次; 浏览器重启(调试会话变化)时重新固定.
 * @param {{ targets?: Array<{ port: number, extensionDir: string, label?: string }>, log?: (msg: string) => void }} options
 * @returns {() => void} 停止监听
 */
export function watchDevExtensionPin({ targets = [], log = console.log } = {}) {
  const stops = targets.map(target => watchOne(target, log));
  return () => stops.forEach(stop => stop());
}
