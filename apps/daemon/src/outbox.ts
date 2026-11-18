import type { DaemonEvent } from '@titan/daemon-protocol';

export class DaemonOutbox {
  private readonly events: DaemonEvent[] = [];
  private readonly acknowledged = new Set<string>();

  append(event: DaemonEvent): void {
    if (!this.events.some(existing => existing.eventId === event.eventId)) this.events.push(event);
  }

  pending(): DaemonEvent[] {
    return this.events.filter(event => !this.acknowledged.has(event.eventId));
  }

  acknowledge(eventId: string): void {
    this.acknowledged.add(eventId);
  }
}
