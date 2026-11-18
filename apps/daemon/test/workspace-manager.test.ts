import { describe, expect, it } from 'vitest';
import { WorkspaceManager } from '../src/workspace-manager.js';

describe('WorkspaceManager', () => {
  it('rejects a workspace path outside the configured root', async () => {
    const manager = new WorkspaceManager(['/repo']);
    await expect(manager.assertAllowed('/tmp/other/file.ts')).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });
});
