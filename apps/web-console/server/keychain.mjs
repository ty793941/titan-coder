import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
export const providers = {
  codex: { service: 'titan-openai', credentialRef: 'keychain://titan-openai', baseUrlService: 'titan-openai-base-url', baseUrlRef: 'keychain://titan-openai-base-url' },
  qwen: { service: 'titan-qwen', credentialRef: 'keychain://titan-qwen' },
};

export class KeychainStore {
  constructor(platform = process.platform, run = execute, launch = spawn) {
    this.platform = platform;
    this.run = run;
    this.launch = launch;
  }

  async configured(provider) {
    if (this.platform !== 'darwin' || !Object.hasOwn(providers, provider)) return false;
    try {
      await this.run('/usr/bin/security', ['find-generic-password', '-s', providers[provider].service], { timeout: 5000, maxBuffer: 16384 });
      return true;
    } catch { return false; }
  }

  async save(provider, key) {
    if (this.platform !== 'darwin') throw new Error('KEYCHAIN_UNAVAILABLE');
    if (!Object.hasOwn(providers, provider) || typeof key !== 'string' || !/^[A-Za-z0-9_.-]{12,4096}$/.test(key)) throw new Error('INVALID_CREDENTIAL');
    await this.saveValue(providers[provider].service, key);
  }

  async baseUrlConfigured(provider) {
    if (this.platform !== 'darwin' || !providers[provider]?.baseUrlService) return false;
    try { await this.run('/usr/bin/security', ['find-generic-password', '-s', providers[provider].baseUrlService], { timeout: 5000, maxBuffer: 16384 }); return true; } catch { return false; }
  }

  async saveUrl(provider, value) {
    if (this.platform !== 'darwin') throw new Error('KEYCHAIN_UNAVAILABLE');
    const info = providers[provider];
    if (!info?.baseUrlService || typeof value !== 'string') throw new Error('INVALID_PROVIDER_BASE_URL');
    let url;
    try { url = new URL(value.trim()); } catch { throw new Error('INVALID_PROVIDER_BASE_URL'); }
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    if (!['https:', ...(local ? ['http:'] : [])].includes(url.protocol) || url.username || url.password || url.hash || url.search || url.pathname.length > 4096) throw new Error('INVALID_PROVIDER_BASE_URL');
    await this.saveValue(info.baseUrlService, url.href.replace(/\/$/, ''));
  }

  async saveValue(service, value) {
    // 交互命令从 stdin 传入，密钥不出现在进程参数、环境和输出日志中。
    await new Promise((resolve, reject) => {
      const child = this.launch('/usr/bin/security', ['-i'], { stdio: ['pipe', 'ignore', 'ignore'] });
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('KEYCHAIN_SAVE_FAILED')); }, 10000);
      child.once('error', () => { clearTimeout(timer); reject(new Error('KEYCHAIN_SAVE_FAILED')); });
      child.once('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('KEYCHAIN_SAVE_FAILED')); });
      child.stdin.on('error', () => {});
      child.stdin.end(`add-generic-password -U -s ${service} -a titan -w "${value}"\n`);
    });
    try {
      const saved = await this.run('/usr/bin/security', ['find-generic-password', '-s', service, '-w'], { timeout: 5000, maxBuffer: 16384 });
      if (saved.stdout.trim() !== value) throw new Error();
    } catch { throw new Error('KEYCHAIN_SAVE_FAILED'); }
  }
}
