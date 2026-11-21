import { DomainError } from '@titan/contracts';
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureSafeDirectory } from './security.js';

export type LedgerEntry = {
  toolCallId: string;
  toolName: string;
  inputHash: string;
  output?: unknown;
  status: 'inflight' | 'success' | 'uncertain';
};

export type ToolLedger = {
  begin(entry: Omit<LedgerEntry, 'status'>): Promise<LedgerEntry | undefined>;
  success(entry: Omit<LedgerEntry, 'status'>): Promise<void>;
  uncertain(entry: Omit<LedgerEntry, 'status'>): Promise<void>;
  discard(entry: Pick<LedgerEntry, 'toolName' | 'inputHash'>): Promise<void>;
};

function keyOf(entry: Pick<LedgerEntry, 'toolName' | 'inputHash'>): string {
  return createHash('sha256').update(`${entry.toolName}\0${entry.inputHash}`).digest('hex');
}

export class MemoryToolExecutionLedger implements ToolLedger {
  private readonly entries = new Map<string, LedgerEntry>();

  async begin(entry: Omit<LedgerEntry, 'status'>): Promise<LedgerEntry | undefined> {
    const key = keyOf(entry);
    const previous = this.entries.get(key);
    if (previous?.status === 'success') return previous;
    if (previous) throw new DomainError('TOOL_EXECUTION_FAILED', `TOOL_EXECUTION_UNCERTAIN: tool ${entry.toolName} has an uncertain side effect`);
    const inflight = { ...entry, status: 'inflight' as const };
    this.entries.set(key, inflight);
    return undefined;
  }

  async success(entry: Omit<LedgerEntry, 'status'>): Promise<void> { this.entries.set(keyOf(entry), { ...entry, status: 'success' }); }
  async uncertain(entry: Omit<LedgerEntry, 'status'>): Promise<void> { this.entries.set(keyOf(entry), { ...entry, status: 'uncertain' }); }
  async discard(entry: Pick<LedgerEntry, 'toolName' | 'inputHash'>): Promise<void> { this.entries.delete(keyOf(entry)); }
}

export class FileToolExecutionLedger implements ToolLedger {
  private rootPromise: Promise<string> | undefined;
  constructor(private readonly root: string, private readonly workspacePath?: string) {}

  async begin(entry: Omit<LedgerEntry, 'status'>): Promise<LedgerEntry | undefined> {
    const file = await this.file(entry);
    const previous = await this.read(file);
    if (previous?.status === 'success') return previous;
    if (previous) {
      await this.write(file, { ...previous, status: 'uncertain' });
      throw new DomainError('TOOL_EXECUTION_FAILED', `TOOL_EXECUTION_UNCERTAIN: tool ${entry.toolName} has an uncertain side effect`);
    }
    await this.write(file, { ...entry, status: 'inflight' });
    return undefined;
  }

  async success(entry: Omit<LedgerEntry, 'status'>): Promise<void> { await this.write(await this.file(entry), { ...entry, status: 'success' }); }
  async uncertain(entry: Omit<LedgerEntry, 'status'>): Promise<void> { await this.write(await this.file(entry), { ...entry, status: 'uncertain' }); }
  async discard(entry: Pick<LedgerEntry, 'toolName' | 'inputHash'>): Promise<void> { await unlink(await this.file(entry)).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }

  private async file(entry: Pick<LedgerEntry, 'toolName' | 'inputHash'>): Promise<string> {
    const root = await this.rootDirectory();
    return join(root, `${keyOf(entry)}.json`);
  }

  private async rootDirectory(): Promise<string> {
    this.rootPromise ??= ensureSafeDirectory(this.root, this.workspacePath);
    return this.rootPromise;
  }

  private async read(file: string): Promise<LedgerEntry | undefined> {
    try { return JSON.parse(await readFile(file, 'utf8')) as LedgerEntry; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw new DomainError('TOOL_EXECUTION_FAILED', 'TOOL_EXECUTION_UNCERTAIN: tool ledger is unreadable'); }
  }

  private async write(file: string, entry: LedgerEntry): Promise<void> {
    const temporary = `${file}.${process.pid}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(entry), { encoding: 'utf8', mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, file);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw new DomainError('TOOL_EXECUTION_FAILED', 'TOOL_EXECUTION_UNCERTAIN: tool ledger could not be persisted', { cause: String(error) });
    }
  }
}
