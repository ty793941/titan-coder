import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { createGateway } from './gateway.mjs';
import { assertPortAvailable, waitForControlPlane } from './lifecycle.mjs';

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const consoleToken = randomBytes(32).toString('hex');
const controlPlanePort = Number(process.env.TITAN_CONTROL_PLANE_PORT ?? 3301);
const port = Number(process.env.TITAN_UI_PORT ?? 5173);
if (![controlPlanePort, port].every(value => Number.isSafeInteger(value) && value > 1024 && value < 65536) || port === controlPlanePort) throw new Error('INVALID_LOCAL_PORT');
const controlPlaneUrl = `http://127.0.0.1:${controlPlanePort}`;
await assertPortAvailable(controlPlanePort).catch(() => {
  process.stderr.write('CONTROL_PLANE_PORT_IN_USE: 专用控制面端口已被占用，请停止旧的 UI 服务或设置 TITAN_CONTROL_PLANE_PORT。\n');
  process.exit(1);
});
const controlPlane = spawn(process.execPath, [join(root, 'apps/control-plane/dist/main.js')], {
  cwd: root,
  env: { ...process.env, CONTROL_PLANE_PORT: String(controlPlanePort), TITAN_CONSOLE_TOKEN: consoleToken, DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://titan:titan@127.0.0.1:55432/titan' },
  stdio: 'ignore',
});
let cpExited = false;
controlPlane.once('error', () => { cpExited = true; });
controlPlane.once('exit', () => {
  cpExited = true;
  if (!stopping) {
    process.stderr.write('CONTROL_PLANE_STOPPED: 控制面已停止，请检查数据库后重新启动 UI。\n');
    process.exitCode = 1;
    void stop();
  }
});
const gateway = createGateway({ root, controlPlaneUrl, consoleToken, allowDevOrigin: process.env.TITAN_UI_DEV === '1' });
let stopping;
async function stop() {
  if (stopping) return stopping;
  stopping = (async () => {
    await gateway.close();
    if (!cpExited) await new Promise(resolveStop => {
      const timer = setTimeout(() => { controlPlane.kill('SIGKILL'); resolveStop(); }, 3000);
      controlPlane.once('exit', () => { clearTimeout(timer); resolveStop(); }); controlPlane.kill('SIGTERM');
    });
  })();
  return stopping;
}
process.once('SIGINT', () => { void stop(); });
process.once('SIGTERM', () => { void stop(); });
gateway.server.once('error', async () => { process.stderr.write('UI_START_FAILED: 请检查本机端口是否已被占用。\n'); process.exitCode = 1; await stop(); });
try {
  await waitForControlPlane(controlPlane, controlPlaneUrl, consoleToken);
  if (!cpExited && !stopping) gateway.server.listen(port, '127.0.0.1', () => { process.stdout.write(`Titan 项目工作台：http://127.0.0.1:${port}/#/\n开发验收入口：http://127.0.0.1:${port}/#/acceptance\n控制面：${controlPlaneUrl}；Key 仅保存在本机钥匙串。\n`); });
} catch {
  process.stderr.write('CONTROL_PLANE_START_FAILED: 控制面未就绪，请确认 PostgreSQL 已启动，并先执行 pnpm build。\n');
  process.exitCode = 1;
  await stop();
}
