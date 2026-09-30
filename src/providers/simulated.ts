/**
 * A supplier stand-in for local development and tests. It honors idempotency
 * keys the way a real booking rail does, and can be scripted to time out
 * after accepting a request, which is the case that matters most.
 */
import type { LookupOutcome, ProviderAdapter, ProviderOutcome } from "@/domain/execution";

export type Script = "accept" | "reject" | "retryable" | "timeout_after_accept" | "timeout_before_accept";

export class SimulatedSupplier implements ProviderAdapter {
  readonly name = "simulated";
  private readonly reservations = new Map<string, string>();
  private seq = 1000;
  submits = 0;

  constructor(private readonly script: Script[] = []) {}

  async submit(key: string, _payload: unknown): Promise<ProviderOutcome> {
    this.submits++;
    const existing = this.reservations.get(key);
    if (existing) return { kind: "accepted", providerRef: existing };
    const step = this.script.shift() ?? "accept";
    switch (step) {
      case "accept":
        return { kind: "accepted", providerRef: this.reserve(key) };
      case "reject":
        return { kind: "rejected", error: "Sold out" };
      case "retryable":
        return { kind: "retryable", error: "Rate limited before acceptance" };
      case "timeout_after_accept":
        this.reserve(key);
        throw new Error("ETIMEDOUT");
      case "timeout_before_accept":
        throw new Error("ECONNRESET");
    }
  }

  async lookup(key: string): Promise<LookupOutcome> {
    const ref = this.reservations.get(key);
    return ref ? { kind: "found", providerRef: ref } : { kind: "absent" };
  }

  get reservationCount(): number {
    return this.reservations.size;
  }

  private reserve(key: string): string {
    const ref = `SIM-${this.seq++}`;
    this.reservations.set(key, ref);
    return ref;
  }
}
