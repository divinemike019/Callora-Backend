/**
 * SloAlertEvaluator
 *
 * Evaluates per-route metric values (error rate, p95 latency) against the
 * thresholds stored in {@link SloThresholdStore}.  When a metric exceeds its
 * threshold an alert is:
 *   1. Recorded via the Prometheus burn-alert counter.
 *   2. (Optionally) POSTed to a configured webhook URL.
 *   3. Returned in the evaluation result so the admin API can surface it.
 *
 * Metric values are read directly from the Prometheus registry so the
 * evaluator requires no additional DB queries.
 *
 * Design deliberately mirrors {@link createSlowQueryAlerterJob} – polling
 * interval, dedup window, and webhook delivery follow the same patterns.
 */

import { register } from '../metrics.js';
import {
  recordSloBurnAlert,
  recordSloRouteErrorRate,
  recordSloRouteLatencyP95,
} from '../metrics.js';
import type { SloThreshold, SloThresholdStore } from './sloThresholdStore.js';
import { logger } from '../logger.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SloAlertEvaluatorOptions {
  /** Webhook endpoint to POST alerts to (optional). */
  webhookUrl?: string;
  /** Polling interval in milliseconds (used when running as a background job). */
  evalIntervalMs: number;
  /** Logger instance (defaults to the shared application logger). */
  logger?: Pick<typeof logger, 'info' | 'warn' | 'error'>;
}

export interface SloViolation {
  thresholdId: string;
  route: string;
  alertType: 'error_rate' | 'latency_p95';
  observedValue: number;
  thresholdValue: number;
  /** True when this violation was already fired in a recent evaluation cycle. */
  suppressed: boolean;
}

export interface SloEvaluationResult {
  evaluatedAt: string;
  routesEvaluated: number;
  violationsDetected: number;
  violations: SloViolation[];
}

// ── Registry metric reader ────────────────────────────────────────────────────

interface MetricEntry {
  value: number;
  labels: Record<string, string>;
  metricName?: string;
}

async function getMetricValues(metricName: string): Promise<MetricEntry[]> {
  const metrics = await register.getMetricsAsJSON();
  const found = metrics.find((m: any) => m.name === metricName);
  return (found?.values ?? []) as MetricEntry[];
}

/**
 * Read the current total request count and error count for a route from the
 * Prometheus http_requests_total counter, filtered to the trailing window.
 *
 * NOTE: Prometheus counters are monotonically increasing; this function
 * reads the *cumulative* counters, which gives the lifetime error rate.
 * For a true sliding-window error rate you would need a different storage
 * layer.  This implementation intentionally uses the simpler lifetime-rate
 * approach so it stays dependency-free and consistent with the existing
 * Prometheus-only observability stack.
 *
 * Returns { errorRate: 0–1, total } or null when no data exists.
 */
export async function readRouteErrorRate(
  route: string,
): Promise<{ errorRate: number; total: number } | null> {
  const values = await getMetricValues('http_requests_total');
  const routeValues = values.filter((v) => v.labels?.route === route);

  if (routeValues.length === 0) return null;

  let total = 0;
  let errors = 0;

  for (const v of routeValues) {
    total += v.value;
    const status = v.labels?.status_code ?? '';
    // 5xx responses are counted as errors; 4xx are client errors, not service errors
    if (status.startsWith('5')) {
      errors += v.value;
    }
  }

  if (total === 0) return null;

  return { errorRate: errors / total, total };
}

/**
 * Read the p95 latency for a route from the Prometheus
 * http_request_duration_seconds histogram.
 *
 * Uses linear interpolation within the containing bucket (same approach as
 * {@link getUpstreamHealth} in metrics.ts).
 *
 * Returns the p95 value in **seconds**, or null when no observations exist.
 */
export async function readRouteLatencyP95(route: string): Promise<number | null> {
  const values = await getMetricValues('http_request_duration_seconds');
  const routeValues = values.filter((v) => v.labels?.route === route);

  if (routeValues.length === 0) return null;

  // Aggregate buckets and count across all label combinations for this route
  const bucketCounts = new Map<number, number>();
  let totalCount = 0;

  for (const v of routeValues) {
    if (v.metricName?.endsWith('_bucket')) {
      const le = v.labels?.le;
      if (le && le !== '+Inf') {
        const bound = parseFloat(le);
        if (!isNaN(bound)) {
          bucketCounts.set(bound, (bucketCounts.get(bound) ?? 0) + v.value);
        }
      }
    } else if (v.metricName?.endsWith('_count')) {
      totalCount += v.value;
    }
  }

  if (totalCount === 0) return null;

  const sortedBounds = [...bucketCounts.keys()].sort((a, b) => a - b);

  let cumulativeCount = 0;
  const cumulativeBuckets: Array<{ bound: number; cumulative: number }> = [];

  for (const bound of sortedBounds) {
    cumulativeCount += bucketCounts.get(bound) ?? 0;
    cumulativeBuckets.push({ bound, cumulative: cumulativeCount });
  }

  const target = totalCount * 0.95;
  let prevBound = 0;
  let prevCumulative = 0;

  for (const bucket of cumulativeBuckets) {
    if (bucket.cumulative >= target) {
      const bucketWidth = bucket.bound - prevBound;
      const countInBucket = bucket.cumulative - prevCumulative;
      if (countInBucket <= 0) return bucket.bound;
      const offsetInBucket = (target - prevCumulative) / countInBucket;
      return prevBound + offsetInBucket * bucketWidth;
    }
    prevBound = bucket.bound;
    prevCumulative = bucket.cumulative;
  }

  return cumulativeBuckets.length > 0
    ? cumulativeBuckets[cumulativeBuckets.length - 1].bound
    : null;
}

// ── Webhook delivery ──────────────────────────────────────────────────────────

function buildAlertPayload(
  violations: SloViolation[],
  evaluatedAt: string,
): object {
  return {
    event: 'slo_burn_alert',
    timestamp: evaluatedAt,
    data: {
      violationCount: violations.length,
      violations: violations.map((v) => ({
        thresholdId: v.thresholdId,
        route: v.route,
        alertType: v.alertType,
        observedValue: v.observedValue,
        thresholdValue: v.thresholdValue,
      })),
    },
  };
}

async function postAlert(
  webhookUrl: string,
  payload: object,
  log: Pick<typeof logger, 'info' | 'error'>,
): Promise<void> {
  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Callora-SloAlertEvaluator/1.0',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      log.error(
        `[sloEvaluator] Webhook returned ${response.status}`,
        response.statusText,
      );
    }
  } catch (err) {
    log.error('[sloEvaluator] Webhook post failed:', (err as Error).message);
  }
}

// ── Core evaluation logic ─────────────────────────────────────────────────────

export interface SloAlertEvaluator {
  /**
   * Evaluate all configured thresholds against current metric values.
   * This is the core method — both the background job and the admin
   * "evaluate now" endpoint call this directly.
   */
  evaluate(thresholds: SloThreshold[]): Promise<SloEvaluationResult>;
  /** Start the background polling timer. */
  start(store: SloThresholdStore): void;
  /** Stop the background polling timer. */
  stop(): void;
  /** Signal graceful shutdown (stop accepting new cycles). */
  beginShutdown(): void;
  /** Wait for any in-flight evaluation cycle to complete. */
  awaitIdle(): Promise<void>;
}

/**
 * Simple in-process dedup store that suppresses repeat alerts for the same
 * route + alert_type pair within a cooldown window.
 */
function createEvalDedupStore(windowMs: number) {
  const store = new Map<string, number>();
  return {
    has(key: string): boolean {
      const expiry = store.get(key);
      if (expiry === undefined) return false;
      if (Date.now() > expiry) {
        store.delete(key);
        return false;
      }
      return true;
    },
    set(key: string): void {
      store.set(key, Date.now() + windowMs);
    },
  };
}

/**
 * Factory function that creates a fully configured SloAlertEvaluator.
 *
 * @param options  Evaluator options (webhook URL, interval, logger).
 */
export function createSloAlertEvaluator(options: SloAlertEvaluatorOptions): SloAlertEvaluator {
  const log = options.logger ?? logger;
  // Suppress re-alerts for the same (route, alertType) within one evaluation window.
  const dedup = createEvalDedupStore(options.evalIntervalMs);

  let timer: NodeJS.Timeout | null = null;
  let accepting = true;
  let running: Promise<void> | null = null;

  const evaluate = async (
    thresholds: SloThreshold[],
  ): Promise<SloEvaluationResult> => {
    const evaluatedAt = new Date().toISOString();
    const violations: SloViolation[] = [];
    const uniqueRoutes = new Set(thresholds.map((t) => t.route));

    for (const threshold of thresholds) {
      const { route } = threshold;

      // ── Error rate ──────────────────────────────────────────────────────
      const errorRateData = await readRouteErrorRate(route);
      if (errorRateData !== null) {
        recordSloRouteErrorRate(route, errorRateData.errorRate);

        if (errorRateData.errorRate > threshold.errorRateThreshold) {
          const key = `${threshold.id}:error_rate`;
          const suppressed = dedup.has(key);
          if (!suppressed) {
            dedup.set(key);
            recordSloBurnAlert(route, 'error_rate');
          }
          violations.push({
            thresholdId: threshold.id,
            route,
            alertType: 'error_rate',
            observedValue: Math.round(errorRateData.errorRate * 10_000) / 10_000,
            thresholdValue: threshold.errorRateThreshold,
            suppressed,
          });
        }
      }

      // ── Latency p95 ─────────────────────────────────────────────────────
      const latencyP95Sec = await readRouteLatencyP95(route);
      if (latencyP95Sec !== null) {
        recordSloRouteLatencyP95(route, latencyP95Sec);

        const latencyP95Ms = latencyP95Sec * 1000;
        if (latencyP95Ms > threshold.latencyP95Ms) {
          const key = `${threshold.id}:latency_p95`;
          const suppressed = dedup.has(key);
          if (!suppressed) {
            dedup.set(key);
            recordSloBurnAlert(route, 'latency_p95');
          }
          violations.push({
            thresholdId: threshold.id,
            route,
            alertType: 'latency_p95',
            observedValue: Math.round(latencyP95Ms * 100) / 100,
            thresholdValue: threshold.latencyP95Ms,
            suppressed,
          });
        }
      }
    }

    const result: SloEvaluationResult = {
      evaluatedAt,
      routesEvaluated: uniqueRoutes.size,
      violationsDetected: violations.length,
      violations,
    };

    // Fire webhook for non-suppressed violations.
    const newViolations = violations.filter((v) => !v.suppressed);
    if (newViolations.length > 0 && options.webhookUrl) {
      const payload = buildAlertPayload(newViolations, evaluatedAt);
      await postAlert(options.webhookUrl, payload, log);
      log.info(
        `[sloEvaluator] Fired ${newViolations.length} SLO burn alert(s)`,
      );
    }

    return result;
  };

  const tick = async (store: SloThresholdStore): Promise<void> => {
    if (!accepting || running) return;

    running = (async () => {
      try {
        const thresholds = store.list();
        if (thresholds.length > 0) {
          await evaluate(thresholds);
        }
      } catch (err) {
        log.error('[sloEvaluator] Evaluation cycle failed:', err);
      } finally {
        running = null;
      }
    })();

    await running;
  };

  return {
    evaluate,

    start(store: SloThresholdStore) {
      if (timer || !accepting) return;
      void tick(store);
      timer = setInterval(() => void tick(store), options.evalIntervalMs);
    },

    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },

    beginShutdown() {
      accepting = false;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },

    async awaitIdle() {
      await (running ?? Promise.resolve());
    },
  };
}
