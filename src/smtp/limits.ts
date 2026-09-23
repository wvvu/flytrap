import { countInWindow, evaluateConnect, evaluateDataRate, type Decision } from "./policy.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

export interface ConnectLimits {
  maxActive: number;
  maxPerMinute: number;
}

/**
 * In-process ceilings for one SMTP role.
 * v0.2 is a single process, so this map is the whole limiter.
 */
export class IpLimiter {
  private readonly active = new Map<string, number>();
  private readonly connects = new Map<string, number[]>();
  private readonly data = new Map<string, number[]>();

  admitConnect(ip: string, now: number, limits: ConnectLimits): Decision {
    const recent = this.window(this.connects, ip, now, MINUTE_MS);
    const decision = evaluateConnect({
      activeConnections: this.active.get(ip) ?? 0,
      connectsInWindow: countInWindow(recent, now, MINUTE_MS),
      maxActive: limits.maxActive,
      maxPerMinute: limits.maxPerMinute,
    });
    recent.push(now);
    this.connects.set(ip, recent);
    if (decision.accept) this.active.set(ip, (this.active.get(ip) ?? 0) + 1);
    return decision;
  }

  release(ip: string): void {
    const next = (this.active.get(ip) ?? 0) - 1;
    if (next <= 0) this.active.delete(ip);
    else this.active.set(ip, next);
  }

  admitData(ip: string, now: number, maxPerHour: number): Decision {
    const recent = this.window(this.data, ip, now, HOUR_MS);
    const decision = evaluateDataRate(countInWindow(recent, now, HOUR_MS), maxPerHour);
    recent.push(now);
    this.data.set(ip, recent);
    return decision;
  }

  private window(store: Map<string, number[]>, ip: string, now: number, windowMs: number): number[] {
    const cutoff = now - windowMs;
    const current = store.get(ip) ?? [];
    let index = 0;
    while (index < current.length && (current[index] ?? 0) < cutoff) index += 1;
    return index === 0 ? current : current.slice(index);
  }
}
