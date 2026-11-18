import { describe, expect, it } from 'vitest';
import { createArtifactVersion } from '../src';

describe('artifact versions', () => {
  it('creates version one with an immutable checksum reference', () => {
    const artifact = createArtifactVersion({
      artifactId: 'artifact_1',
      projectId: 'project_1',
      taskId: 'task_1',
      type: 'questions',
      uri: 'file:///tmp/questions.md',
      content: '# Questions',
      createdBy: { type: 'agent', id: 'project-manager' },
    });

    expect(artifact.version).toBe(1);
    expect(artifact.checksum).toMatch(/^sha256:/);
  });
});
