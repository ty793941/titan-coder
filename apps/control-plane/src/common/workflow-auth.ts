import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { DomainError } from '@titan/contracts';
import { sameToken, tokenHash } from '../modules/daemons/execution-policy.js';
import { DatabaseService } from '../database/database.service.js';

export type WorkflowIdentityConfig = { workerId: string; credentialRef: string };
export type WorkflowCredentialResolver = (ref: string) => Promise<string>;

export async function resolveWorkflowCredential(ref: string): Promise<string> {
  const keychain = /^keychain:\/\/([A-Za-z0-9_-]{1,200})$/.exec(ref);
  try {
    if (keychain && process.platform === 'darwin') {
      const result = await promisify(execFile)('/usr/bin/security', ['find-generic-password', '-s', keychain[1]!, '-a', 'titan', '-w'], { maxBuffer: 4096, timeout: 5000 });
      return result.stdout.trim();
    }
    if (ref === 'stdin://workflow' && !process.stdin.isTTY) {
      let value = '';
      for await (const chunk of process.stdin) {
        value += String(chunk);
        if (Buffer.byteLength(value) > 4096) throw new Error();
      }
      return value.trim();
    }
  } catch { throw new DomainError('PERMISSION_DENIED', 'workflow identity could not be loaded'); }
  throw new DomainError('PERMISSION_DENIED', 'workflow identity requires Keychain or controlled stdin');
}

@Injectable()
export class WorkflowAuth {
  private identity: { workerId: string; tokenHash: string } | undefined;

  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async initialize(config?: WorkflowIdentityConfig, resolver: WorkflowCredentialResolver = resolveWorkflowCredential): Promise<void> {
    if (!config) return;
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(config.workerId)) throw new DomainError('VALIDATION_FAILED', 'invalid workflow worker identity');
    const value = await resolver(config.credentialRef);
    if (!/^[^\s]{16,4096}$/.test(value) || value === process.env.TITAN_CONSOLE_TOKEN) throw new DomainError('PERMISSION_DENIED', 'workflow identity must be independent');
    const daemon = await this.database.db.selectFrom('daemon').select('id').where('auth_token_hash', '=', tokenHash(value)).executeTakeFirst();
    if (daemon) throw new DomainError('PERMISSION_DENIED', 'workflow identity must be independent of daemon credentials');
    this.identity = { workerId: config.workerId, tokenHash: tokenHash(value) };
  }

  authenticate(authorization?: string): string {
    const match = /^Bearer ([^\s]+)$/i.exec(authorization ?? '');
    if (!this.identity || !match || !sameToken(match[1]!, this.identity.tokenHash) || match[1] === process.env.TITAN_CONSOLE_TOKEN) {
      throw new UnauthorizedException('invalid workflow credentials');
    }
    return this.identity.workerId;
  }
}
