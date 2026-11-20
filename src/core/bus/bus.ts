import { EventSchemas, type EventName, type EventPayload, type ModuleName } from "./events";

/**
 * In-process event bus. It lives in server memory only: there is no HTTP
 * route, queue, or socket attached to it, so nothing outside the running app
 * can publish or listen. Handlers run after the publisher's work is done;
 * one failing handler never breaks the publisher or the other handlers.
 *
 * Handlers must be idempotent (they key their writes on the source id), so a
 * replayed event is harmless.
 */
type Handler<N extends EventName> = (payload: EventPayload<N>) => Promise<void> | void;

type Subscription = { module: ModuleName; handler: Handler<EventName> };

export type DeliveryResult = { module: ModuleName; ok: boolean; error?: string };

export class EventBus {
  private subs = new Map<EventName, Subscription[]>();

  subscribe<N extends EventName>(event: N, module: ModuleName, handler: Handler<N>): void {
    const list = this.subs.get(event) ?? [];
    list.push({ module, handler: handler as Handler<EventName> });
    this.subs.set(event, list);
  }

  async publish<N extends EventName>(
    publisher: ModuleName,
    event: N,
    payload: EventPayload<N>,
  ): Promise<DeliveryResult[]> {
    if (!event.startsWith(`${publisher}.`)) {
      throw new Error(`Module "${publisher}" may not publish "${event}"`);
    }
    const data = EventSchemas[event].parse(payload) as EventPayload<N>;
    const list = this.subs.get(event) ?? [];
    const settled = await Promise.allSettled(list.map((s) => Promise.resolve().then(() => s.handler(data))));
    return settled.map((r, i) => {
      const subscriber = list[i].module;
      if (r.status === "fulfilled") return { module: subscriber, ok: true };
      const error = r.reason instanceof Error ? r.reason.message : String(r.reason);
      console.error(`[bus] ${subscriber} failed handling ${event}: ${error}`);
      return { module: subscriber, ok: false, error };
    });
  }

  subscribers(event: EventName): ModuleName[] {
    return (this.subs.get(event) ?? []).map((s) => s.module);
  }
}
