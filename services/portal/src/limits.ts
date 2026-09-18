/**
 * Per-address rate limits for the endpoints anyone can reach.
 *
 * In memory: a restart forgets them, and several portal processes would each
 * keep their own. Both are acceptable for what they guard — a form being
 * flooded, a password being sprayed — where the account lockout and the
 * review of every application are the real defences.
 */
export class RateLimit {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #hits = new Map<string, number[]>();

  constructor(limit: number, windowMs: number) {
    this.#limit = limit;
    this.#windowMs = windowMs;
  }

  /** Count one attempt; false if this address has used up its window. */
  take(key: string, now = Date.now()): boolean {
    const recent = (this.#hits.get(key) ?? []).filter((t) => now - t < this.#windowMs);
    if (recent.length >= this.#limit) {
      this.#hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.#hits.set(key, recent);
    if (this.#hits.size > 10_000) this.#sweep(now);
    return true;
  }

  #sweep(now: number): void {
    for (const [key, times] of this.#hits) {
      if (times.every((t) => now - t >= this.#windowMs)) this.#hits.delete(key);
    }
  }
}
