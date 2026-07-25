/**
 * SloThresholdStore
 *
 * In-memory CRUD store for per-route SLO threshold configurations.
 * Each record defines the acceptable error-rate, p95 latency, and the
 * burn-window used to evaluate the current metric values.
 *
 * This is intentionally an in-memory store (like the anomaly dedup store)
 * so that the evaluation path stays completely synchronous and adds zero
 * DB round-trips per evaluation cycle.  Configs survive for the process
 * lifetime and can be managed at runtime via the admin API.
 */

import { randomUUID } from 'node:crypto';

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * The persisted shape of a single per-route SLO threshold configuration.
 */
export interface SloThreshold {
  /** Stable identifier (UUID v4). */
  id: string;
  /**
   * The route pattern this threshold applies to.
   * Must match the parameterised Express pattern stored in Prometheus label
   * `route` (e.g. `/api/billing/:id`, `/v1/call/:apiId`).
   */
  route: string;
  /**
   * Maximum acceptable error rate (0–1, inclusive).
   * E.g. `0.05` means alert when ≥ 5 % of requests in the burn window fail.
   */
  errorRateThreshold: number;
  /**
   * Maximum acceptable 95th-percentile latency **in milliseconds**.
   * E.g. `500` means alert when p95 exceeds 500 ms.
   */
  latencyP95Ms: number;
  /**
   * Evaluation window **in seconds**.
   * Metrics are aggregated over this trailing window before being compared
   * against the thresholds.  Defaults to 300 (5 minutes).
   */
  burnWindowSeconds: number;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** ISO-8601 last-update timestamp. */
  updatedAt: string;
}

/** Fields accepted when creating a new threshold. */
export interface CreateSloThresholdInput {
  route: string;
  errorRateThreshold: number;
  latencyP95Ms: number;
  burnWindowSeconds?: number;
}

/** Subset of fields that may be patched via PUT. */
export interface UpdateSloThresholdInput {
  route?: string;
  errorRateThreshold?: number;
  latencyP95Ms?: number;
  burnWindowSeconds?: number;
}

// ── Constants ─────────────────────────────────────────────────────────────────

export const DEFAULT_BURN_WINDOW_SECONDS = 300;

// ── Store ─────────────────────────────────────────────────────────────────────

export interface SloThresholdStore {
  /** Return all stored thresholds. */
  list(): SloThreshold[];
  /** Find a single threshold by its id. Returns undefined when not found. */
  findById(id: string): SloThreshold | undefined;
  /** Find all thresholds matching a specific route pattern. */
  findByRoute(route: string): SloThreshold[];
  /** Persist a new threshold. Throws if a threshold already exists for the same route. */
  create(input: CreateSloThresholdInput): SloThreshold;
  /**
   * Replace mutable fields of an existing threshold.
   * Returns the updated record or undefined when not found.
   */
  update(id: string, input: UpdateSloThresholdInput): SloThreshold | undefined;
  /**
   * Remove a threshold by id.
   * Returns `true` if it existed, `false` otherwise.
   */
  delete(id: string): boolean;
  /** Wipe all records (intended for testing). */
  clear(): void;
}

/**
 * Create a new, isolated SloThresholdStore backed by an in-process Map.
 *
 * Duplicate-route guard: the store refuses to create a second threshold for
 * the same route string.  Operators must DELETE then re-CREATE, or use PUT
 * to update the existing record.
 */
export function createSloThresholdStore(): SloThresholdStore {
  const store = new Map<string, SloThreshold>();

  return {
    list(): SloThreshold[] {
      return [...store.values()];
    },

    findById(id: string): SloThreshold | undefined {
      return store.get(id);
    },

    findByRoute(route: string): SloThreshold[] {
      return [...store.values()].filter((t) => t.route === route);
    },

    create(input: CreateSloThresholdInput): SloThreshold {
      const existing = [...store.values()].find((t) => t.route === input.route);
      if (existing) {
        throw new Error(
          `A threshold for route "${input.route}" already exists (id: ${existing.id}). ` +
            'Use PUT to update it or DELETE it first.',
        );
      }

      const now = new Date().toISOString();
      const threshold: SloThreshold = {
        id: randomUUID(),
        route: input.route,
        errorRateThreshold: input.errorRateThreshold,
        latencyP95Ms: input.latencyP95Ms,
        burnWindowSeconds: input.burnWindowSeconds ?? DEFAULT_BURN_WINDOW_SECONDS,
        createdAt: now,
        updatedAt: now,
      };

      store.set(threshold.id, threshold);
      return threshold;
    },

    update(id: string, input: UpdateSloThresholdInput): SloThreshold | undefined {
      const existing = store.get(id);
      if (!existing) return undefined;

      // Guard: if the route is being changed ensure no collision with another record.
      if (input.route !== undefined && input.route !== existing.route) {
        const collision = [...store.values()].find(
          (t) => t.id !== id && t.route === input.route,
        );
        if (collision) {
          throw new Error(
            `A threshold for route "${input.route}" already exists (id: ${collision.id}).`,
          );
        }
      }

      const updated: SloThreshold = {
        ...existing,
        route: input.route ?? existing.route,
        errorRateThreshold:
          input.errorRateThreshold !== undefined
            ? input.errorRateThreshold
            : existing.errorRateThreshold,
        latencyP95Ms:
          input.latencyP95Ms !== undefined ? input.latencyP95Ms : existing.latencyP95Ms,
        burnWindowSeconds:
          input.burnWindowSeconds !== undefined
            ? input.burnWindowSeconds
            : existing.burnWindowSeconds,
        updatedAt: new Date().toISOString(),
      };

      store.set(id, updated);
      return updated;
    },

    delete(id: string): boolean {
      return store.delete(id);
    },

    clear(): void {
      store.clear();
    },
  };
}

/** Module-level singleton used by the application at runtime. */
export const sloThresholdStore = createSloThresholdStore();
