import { execFileSync } from 'node:child_process';

export function initializeSnapshotRepository(path: string): void {
  const options = { stdio: 'pipe' as const, timeout: 5000 };
  execFileSync('git', ['-C', path, 'init', '-q'], options);
  execFileSync('git', ['-C', path, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-qm', 'snapshot baseline'], options);
}
