import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

describe('Control Plane daemon API', () => {
  it('registers, heartbeats, revokes a daemon, and deduplicates outbox events', async () => {
    const { createTestApp } = await import('../src/test-app.js');
    const api = await createTestApp();
    const suffix = randomUUID();
    const registration = await api.post('/api/daemons/register').send({
      machineName: `machine-${suffix}`,
      environmentType: 'local',
      capabilities: ['codex', 'git'],
      workspaceRoots: ['/tmp/titan'],
      maxConcurrentSessions: 2,
      daemonVersion: '0.1.0',
    }).expect(201);

    expect(registration.body.status).toBe('ready');
    const authorization = `Bearer ${registration.body.authToken}`;
    const heartbeat = await api.post(`/api/daemons/${registration.body.daemonId}/heartbeat`)
      .set('Authorization', authorization)
      .send({ sequence: 1 })
      .expect(200);
    expect(heartbeat.body.status).toBe('ready');

    const event = {
      eventId: `daemon-event-${suffix}`,
      daemonId: registration.body.daemonId,
      sequence: 1,
      eventType: 'session.progressed',
      payload: { message: 'running' },
    };
    await api.post(`/api/daemons/${registration.body.daemonId}/events`).set('Authorization', authorization).send(event).expect(201);
    await api.post(`/api/daemons/${registration.body.daemonId}/events`).set('Authorization', authorization).send(event).expect(200);
    await api.post(`/api/daemons/${registration.body.daemonId}/events`).set('Authorization', authorization).send({ ...event, daemonId: 'daemon_other' }).expect(403);
    const events = await api.get(`/api/daemons/${registration.body.daemonId}/events`).set('Authorization', authorization).expect(200);
    expect(events.body).toHaveLength(1);
    expect(events.body[0].eventId).toBe(event.eventId);

    await api.post(`/api/daemons/${registration.body.daemonId}/revoke`).set('Authorization', authorization).expect(204);
    const revoked = await api.get(`/api/daemons/${registration.body.daemonId}`).expect(200);
    expect(revoked.body.status).toBe('revoked');
    await api.close();
  });
});
