import { uuidv7 } from './ids.js';

/**
 * Domain events are the ONLY channel between bounded contexts (system design
 * §2). They are written to the outbox in the same transaction as the aggregate
 * (ADR-007), so they cannot be lost to a dual-write.
 */
export interface DomainEvent<TPayload = unknown> {
  readonly eventId: string;
  readonly eventType: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly occurredAt: Date;
  readonly payload: TPayload;
}

export function createEvent<TPayload>(args: {
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: TPayload;
  occurredAt?: Date;
}): DomainEvent<TPayload> {
  return {
    eventId: uuidv7(),
    eventType: args.eventType,
    aggregateType: args.aggregateType,
    aggregateId: args.aggregateId,
    occurredAt: args.occurredAt ?? new Date(),
    payload: args.payload,
  };
}

/** Aggregates collect events; the repository drains them into the outbox on save. */
export abstract class AggregateRoot {
  #events: DomainEvent[] = [];

  protected record(event: DomainEvent): void {
    this.#events.push(event);
  }

  /** Drains — a second call returns an empty list. */
  pullEvents(): DomainEvent[] {
    const drained = this.#events;
    this.#events = [];
    return drained;
  }

  get pendingEvents(): readonly DomainEvent[] {
    return this.#events;
  }
}
