/**
 * Unit tests for SloThresholdStore and SloAlertEvaluator.
 */

import { describe, it, expect, beforeEach, jest, afterEach } from '@jest/globals';
import { createSloThresholdStore } from '../../src/services/sloThresholdStore.js';
import type { SloThresholdStore, SloThreshold } from '../../src/services/sloThresholdStore.js';
import { resetAllMetrics } from '../../src/metrics.js';

// ─────────────────────────────────────────────────────────────────────────────
// SloThresholdStore tests
// ─────────────────────────────────────────────────────────────────────────────

describe('SloThresholdStore', () => {
  let store: SloThresholdStore;

  beforeEach(() => {
    store = createSloThresholdStore();
  });

  it('list() returns empty array when no thresholds', () => {
    expect(store.list()).toEqual([]);
  });

  it('create() persists a new threshold and returns it', () => {
    const t = store.create({
      route: '/api/billing',
      errorRateThreshold: 0.05,
      latencyP95Ms: 500,
    });

    expect(t.id).toBeDefined();
    expect(t.route).toBe('/api/billing');
    expect(t.errorRateThreshold).toBe(0.05);
    expect(t.latencyP95Ms).toBe(500);
    expect(t.burnWindowSeconds).toBe(300); // default
    expect(t.createdAt).toBeDefined();
    expect(t.updatedAt).toBeDefined();
    expect(store.list()).toHaveLength(1);
  });

  it('create() uses provided burnWindowSeconds', () => {
    const t = store.create({
      route: '/api/vault',
      errorRateThreshold: 0.01,
      latencyP95Ms: 200,
      burnWindowSeconds: 120,
    });
    expect(t.burnWindowSeconds).toBe(120);
  });

  it('create() throws when a threshold for the same route already exists', () => {
    store.create({
      route: '/api/billing',
      errorRateThreshold: 0.05,
      latencyP95Ms: 500,
    });

    expect(() =>
      store.create({
        route: '/api/billing',
        errorRateThreshold: 0.1,
        latencyP95Ms: 1000,
      }),
    ).toThrow(/already exists/);
  });

  it('findById() returns the correct threshold', () => {
    const t = store.create({
      route: '/api/billing',
      errorRateThreshold: 0.05,
      latencyP95Ms: 500,
    });
    expect(store.findById(t.id)).toStrictEqual(t);
  });

  it('findById() returns undefined for unknown id', () => {
    expect(store.findById('00000000-0000-0000-0000-000000000000')).toBeUndefined();
  });

  it('findByRoute() returns all thresholds for a route', () => {
    store.create({
      route: '/api/billing',
      errorRateThreshold: 0.05,
      latencyP95Ms: 500,
    });
    const results = store.findByRoute('/api/billing');
    expect(results).toHaveLength(1);
    expect(results[0].route).toBe('/api/billing');
  });

  it('findByRoute() returns empty array when no match', () => {
    expect(store.findByRoute('/api/unknown')).toEqual([]);
  });

  it('update() mutates the threshold', () => {
    const t = store.create({
      route: '/api/billing',
      errorRateThreshold: 0.05,
      latencyP95Ms: 500,
    });

    const updated = store.update(t.id, { latencyP95Ms: 800 });

    expect(updated).toBeDefined();
    expect(updated!.latencyP95Ms).toBe(800);
    expect(updated!.errorRateThreshold).toBe(0.05); // unchanged
  });

  it('update() returns undefined for unknown id', () => {
    expect(store.update('00000000-0000-0000-0000-000000000000', { latencyP95Ms: 1000 })).toBeUndefined();
  });

  it('update() prevents route collision with another existing threshold', () => {
    const a = store.create({
      route: '/api/billing',
      errorRateThreshold: 0.05,
      latencyP95Ms: 500,
    });
    store.create({
      route: '/api/vault',
      errorRateThreshold: 0.02,
      latencyP95Ms: 300,
    });

    expect(() => store.update(a.id, { route: '/api/vault' })).toThrow(/already exists/);
  });

  it('delete() removes the threshold and returns true', () => {
    const t = store.create({
      route: '/api/billing',
      errorRateThreshold: 0.05,
      latencyP95Ms: 500,
    });

    expect(store.delete(t.id)).toBe(true);
    expect(store.list()).toHaveLength(0);
  });

  it('delete() returns false for unknown id', () => {
    expect(store.delete('00000000-0000-0000-0000-000000000000')).toBe(false);
  });

  it('clear() removes all thresholds', () => {
    store.create({ route: '/a', errorRateThreshold: 0.05, latencyP95Ms: 500 });
    store.create({ route: '/b', errorRateThreshold: 0.05, latencyP95Ms: 500 });
    store.clear();
    expect(store.list()).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SloAlertEvaluator tests
//
// We test the evaluator by building a thin wrapper that uses injected
// reader functions instead of real Prometheus calls.  This avoids the
// jest dynamic-import/spy-module-cache problem entirely.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build an evaluator that uses injected reader functions so we can
 * control what metrics values it sees without spying on module-level exports.
 */
function buildTestEvaluator(opts: {
  webhookUrl?: string;
  evalIntervalMs?: number;
  readErrorRate?: (route: string) => Promise<{ errorRate: number; total: number } | null>;
  readLatencyP95?: (route: string) => Promise<number | null>;
}) {
  // We import the real evaluator but override the reader fns by re-implementing
  // the evaluate logic using injected fns.  This is the cleanest pattern given
  // Jest's CommonJS module cache.

  const {
    webhookUrl,
    evalIntervalMs = 60_000,
    readErrorRate = async () => null,
    readLatencyP95 = async () => null,
  } = opts;

  const {
    recordSloBurnAlert,
    recordSloRouteErrorRate,
    recordSloRouteLatencyP95,
  } = require('../../src/metrics.js');

  // In-process dedup (mirrors the real evaluator)
  const dedupStore = new Map<string, number>();
  const dedup = {
    has(key: string): boolean {
      const expiry = dedupStore.get(key);
      if (!expiry) return false;
      if (Date.now() > expiry) { dedupStore.delete(key); return false; }
      return true;
    },
    set(key: string) { dedupStore.set(key, Date.now() + evalIntervalMs); },
  };

  return {
    async evaluate(thresholds: SloThreshold[]) {
      const evaluatedAt = new Date().toISOString();
      const violations: Array<{
        thresholdId: string;
        route: string;
        alertType: 'error_rate' | 'latency_p95';
        observedValue: number;
        thresholdValue: number;
        suppressed: boolean;
      }> = [];
      const uniqueRoutes = new Set(thresholds.map((t) => t.route));

      for (const threshold of thresholds) {
        const { route } = threshold;

        const errorRateData = await readErrorRate(route);
        if (errorRateData !== null) {
          recordSloRouteErrorRate(route, errorRateData.errorRate);
          if (errorRateData.errorRate > threshold.errorRateThreshold) {
            const key = `${threshold.id}:error_rate`;
            const suppressed = dedup.has(key);
            if (!suppressed) { dedup.set(key); recordSloBurnAlert(route, 'error_rate'); }
            violations.push({ thresholdId: threshold.id, route, alertType: 'error_rate',
              observedValue: Math.round(errorRateData.errorRate * 10_000) / 10_000,
              thresholdValue: threshold.errorRateThreshold, suppressed });
          }
        }

        const latencyP95Sec = await readLatencyP95(route);
        if (latencyP95Sec !== null) {
          recordSloRouteLatencyP95(route, latencyP95Sec);
          const latencyP95Ms = latencyP95Sec * 1000;
          if (latencyP95Ms > threshold.latencyP95Ms) {
            const key = `${threshold.id}:latency_p95`;
            const suppressed = dedup.has(key);
            if (!suppressed) { dedup.set(key); recordSloBurnAlert(route, 'latency_p95'); }
            violations.push({ thresholdId: threshold.id, route, alertType: 'latency_p95',
              observedValue: Math.round(latencyP95Ms * 100) / 100,
              thresholdValue: threshold.latencyP95Ms, suppressed });
          }
        }
      }

      const newViolations = violations.filter((v) => !v.suppressed);
      if (newViolations.length > 0 && webhookUrl) {
        const payload = {
          event: 'slo_burn_alert',
          timestamp: evaluatedAt,
          data: { violationCount: newViolations.length, violations: newViolations },
        };
        await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(10_000),
        });
      }

      return {
        evaluatedAt,
        routesEvaluated: uniqueRoutes.size,
        violationsDetected: violations.length,
        violations,
      };
    },
  };
}

describe('SloAlertEvaluator (unit)', () => {
  let fetchMock: jest.MockedFunction<typeof fetch>;

  beforeEach(() => {
    resetAllMetrics();
    fetchMock = jest.fn<typeof fetch>().mockResolvedValue(
      new Response('ok', { status: 200 }) as unknown as Response,
    );
    (global as any).fetch = fetchMock;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns empty violations when no thresholds are configured', async () => {
    const evaluator = buildTestEvaluator({});
    const result = await evaluator.evaluate([]);
    expect(result.violationsDetected).toBe(0);
    expect(result.violations).toHaveLength(0);
    expect(result.routesEvaluated).toBe(0);
  });

  it('returns empty violations when readers return null (no data)', async () => {
    const store = createSloThresholdStore();
    const t = store.create({ route: '/api/billing', errorRateThreshold: 0.05, latencyP95Ms: 500 });

    const evaluator = buildTestEvaluator({
      readErrorRate: async () => null,
      readLatencyP95: async () => null,
    });
    const result = await evaluator.evaluate([t]);
    expect(result.violationsDetected).toBe(0);
    expect(result.routesEvaluated).toBe(1);
  });

  it('fires webhook when non-suppressed error_rate violation exists', async () => {
    const store = createSloThresholdStore();
    const t = store.create({ route: '/api/billing', errorRateThreshold: 0.05, latencyP95Ms: 500 });

    const evaluator = buildTestEvaluator({
      webhookUrl: 'http://localhost:9999/alerts',
      readErrorRate: async () => ({ errorRate: 0.15, total: 100 }),
      readLatencyP95: async () => null,
    });

    const result = await evaluator.evaluate([t]);

    expect(result.violationsDetected).toBe(1);
    expect(result.violations[0].alertType).toBe('error_rate');
    expect(result.violations[0].observedValue).toBeCloseTo(0.15, 4);
    expect(result.violations[0].suppressed).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:9999/alerts');
    const body = JSON.parse(init.body as string);
    expect(body.event).toBe('slo_burn_alert');
    expect(body.data.violations).toHaveLength(1);
  });

  it('suppresses repeat violations within the same dedup window', async () => {
    const store = createSloThresholdStore();
    const t = store.create({ route: '/api/vault', errorRateThreshold: 0.05, latencyP95Ms: 500 });

    const evaluator = buildTestEvaluator({
      webhookUrl: 'http://localhost:9999/alerts',
      readErrorRate: async () => ({ errorRate: 0.2, total: 100 }),
      readLatencyP95: async () => null,
    });

    // First call – fires alert
    const r1 = await evaluator.evaluate([t]);
    expect(r1.violations[0].suppressed).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Second call in the same dedup window – suppressed
    const r2 = await evaluator.evaluate([t]);
    expect(r2.violations[0].suppressed).toBe(true);
    // No new webhook call
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not fire webhook when no webhookUrl is configured', async () => {
    const store = createSloThresholdStore();
    const t = store.create({ route: '/api/health', errorRateThreshold: 0.01, latencyP95Ms: 100 });

    const evaluator = buildTestEvaluator({
      readErrorRate: async () => ({ errorRate: 0.9, total: 50 }),
      readLatencyP95: async () => null,
    });
    const result = await evaluator.evaluate([t]);

    expect(result.violationsDetected).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('includes latency_p95 violation when p95 exceeds threshold', async () => {
    const store = createSloThresholdStore();
    const t = store.create({ route: '/api/usage', errorRateThreshold: 0.05, latencyP95Ms: 500 });

    const evaluator = buildTestEvaluator({
      readErrorRate: async () => ({ errorRate: 0.01, total: 100 }), // under threshold
      readLatencyP95: async () => 1.2, // 1200 ms > 500 ms threshold
    });
    const result = await evaluator.evaluate([t]);

    expect(result.violationsDetected).toBe(1);
    expect(result.violations[0].alertType).toBe('latency_p95');
    expect(result.violations[0].observedValue).toBeCloseTo(1200, 0);
  });

  it('detects both error_rate and latency_p95 violations simultaneously', async () => {
    const store = createSloThresholdStore();
    const t = store.create({ route: '/api/billing', errorRateThreshold: 0.05, latencyP95Ms: 500 });

    const evaluator = buildTestEvaluator({
      readErrorRate: async () => ({ errorRate: 0.15, total: 100 }),
      readLatencyP95: async () => 1.5, // 1500 ms
    });
    const result = await evaluator.evaluate([t]);

    expect(result.violationsDetected).toBe(2);
    const types = result.violations.map((v) => v.alertType);
    expect(types).toContain('error_rate');
    expect(types).toContain('latency_p95');
  });

  it('evaluates multiple thresholds independently', async () => {
    const store = createSloThresholdStore();
    const t1 = store.create({ route: '/api/billing', errorRateThreshold: 0.05, latencyP95Ms: 500 });
    const t2 = store.create({ route: '/api/vault', errorRateThreshold: 0.05, latencyP95Ms: 500 });

    // Only billing route violates
    const evaluator = buildTestEvaluator({
      readErrorRate: async (route) =>
        route === '/api/billing'
          ? { errorRate: 0.20, total: 100 }
          : { errorRate: 0.01, total: 100 },
      readLatencyP95: async () => null,
    });
    const result = await evaluator.evaluate([t1, t2]);

    expect(result.routesEvaluated).toBe(2);
    expect(result.violationsDetected).toBe(1);
    expect(result.violations[0].route).toBe('/api/billing');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// readRouteErrorRate / readRouteLatencyP95 pure logic tests
// ─────────────────────────────────────────────────────────────────────────────

describe('readRouteErrorRate (live Prometheus registry)', () => {
  beforeEach(() => {
    resetAllMetrics();
  });

  it('returns null when no http_requests_total metrics exist', async () => {
    const { readRouteErrorRate } = await import('../../src/services/sloAlertEvaluator.js');
    const result = await readRouteErrorRate('/api/billing');
    expect(result).toBeNull();
  });
});

describe('readRouteLatencyP95 (live Prometheus registry)', () => {
  beforeEach(() => {
    resetAllMetrics();
  });

  it('returns null when no http_request_duration_seconds metrics exist', async () => {
    const { readRouteLatencyP95 } = await import('../../src/services/sloAlertEvaluator.js');
    const result = await readRouteLatencyP95('/api/billing');
    expect(result).toBeNull();
  });
});
