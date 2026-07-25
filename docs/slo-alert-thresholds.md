# Per-Route SLO Alert Thresholds

Per-route SLO (Service Level Objective) threshold configuration that alerts on error-rate and latency burn. Administrators configure acceptable limits for each route, and the evaluator fires Prometheus metrics and optional webhook alerts when those limits are exceeded.

## Overview

The SLO alert subsystem has three components:

| Component | File | Responsibility |
|---|---|---|
| `SloThresholdStore` | `src/services/sloThresholdStore.ts` | In-memory CRUD for threshold configs |
| `SloAlertEvaluator` | `src/services/sloAlertEvaluator.ts` | Reads Prometheus metrics, evaluates thresholds, fires alerts |
| Admin SLO Router | `src/routes/admin/slo.ts` | REST API to manage thresholds and trigger on-demand evaluation |

## Threshold Configuration

Each threshold record contains:

| Field | Type | Description |
|---|---|---|
| `id` | UUID | Auto-assigned stable identifier |
| `route` | string | Express route pattern (must start with `/`) |
| `errorRateThreshold` | number (0–1) | Alert when 5xx error rate exceeds this fraction |
| `latencyP95Ms` | number (ms) | Alert when p95 latency exceeds this in milliseconds |
| `burnWindowSeconds` | integer | Evaluation window in seconds (default: `300`) |
| `createdAt` | ISO-8601 | Creation timestamp |
| `updatedAt` | ISO-8601 | Last modification timestamp |

## Admin API Endpoints

All endpoints require admin authentication (`x-admin-api-key` or `Authorization: Bearer <JWT role=admin>`).

### List all thresholds

```
GET /api/admin/slo/thresholds
```

Response:
```json
{
  "data": [
    {
      "id": "a1b2c3d4-...",
      "route": "/api/billing",
      "errorRateThreshold": 0.05,
      "latencyP95Ms": 500,
      "burnWindowSeconds": 300,
      "createdAt": "2026-07-25T07:00:00.000Z",
      "updatedAt": "2026-07-25T07:00:00.000Z"
    }
  ],
  "total": 1
}
```

### Create a threshold

```
POST /api/admin/slo/thresholds
Content-Type: application/json

{
  "route": "/api/billing",
  "errorRateThreshold": 0.05,
  "latencyP95Ms": 500,
  "burnWindowSeconds": 300
}
```

Returns `201 Created` with the new threshold. Returns `400` if a threshold for the same route already exists.

### Get a single threshold

```
GET /api/admin/slo/thresholds/:id
```

Returns `200` with the threshold or `404` if not found. Returns `400` if `id` is not a valid UUID.

### Update a threshold

```
PUT /api/admin/slo/thresholds/:id
Content-Type: application/json

{
  "latencyP95Ms": 800
}
```

Partial update — supply only the fields you want to change. Returns `200` with the updated record, `404` if not found, or `400` if the updated `route` would collide with another existing threshold.

### Delete a threshold

```
DELETE /api/admin/slo/thresholds/:id
```

Returns `204 No Content` on success or `404` if not found.

### Trigger on-demand evaluation

```
POST /api/admin/slo/thresholds/evaluate
```

Immediately evaluates all configured thresholds against the current Prometheus metric values and returns the violation report.

Response:
```json
{
  "data": {
    "evaluatedAt": "2026-07-25T07:30:00.000Z",
    "routesEvaluated": 2,
    "violationsDetected": 1,
    "violations": [
      {
        "thresholdId": "a1b2c3d4-...",
        "route": "/api/billing",
        "alertType": "error_rate",
        "observedValue": 0.12,
        "thresholdValue": 0.05,
        "suppressed": false
      }
    ]
  }
}
```

`suppressed: true` means the same violation was already fired in the current evaluation-interval dedup window — the Prometheus counter was already incremented on the first fire, and the webhook was not called again.

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `SLO_EVAL_INTERVAL_MS` | No | `60000` | Background evaluation polling interval in ms |
| `SLO_ALERT_WEBHOOK_URL` | No | — | URL to POST SLO burn alerts to |

When `SLO_ALERT_WEBHOOK_URL` is absent, violations are recorded in Prometheus only (no outbound HTTP).

## Prometheus Metrics

| Metric | Type | Labels | Description |
|---|---|---|---|
| `slo_burn_alerts_total` | Counter | `route`, `alert_type` | Total SLO burn alerts fired |
| `slo_route_error_rate` | Gauge | `route` | Last-observed error rate (0–1) per route |
| `slo_route_latency_p95` | Gauge | `route` | Last-observed p95 latency (seconds) per route |

`alert_type` is either `error_rate` or `latency_p95`.

## Webhook Payload

When `SLO_ALERT_WEBHOOK_URL` is configured, a POST is sent for each evaluation cycle that contains new (non-suppressed) violations:

```json
{
  "event": "slo_burn_alert",
  "timestamp": "2026-07-25T07:30:00.000Z",
  "data": {
    "violationCount": 1,
    "violations": [
      {
        "thresholdId": "a1b2c3d4-...",
        "route": "/api/billing",
        "alertType": "error_rate",
        "observedValue": 0.12,
        "thresholdValue": 0.05,
        "suppressed": false
      }
    ]
  }
}
```

Webhook delivery uses a 10-second timeout. Failures are logged but do not affect the evaluation result.

## Background Job Lifecycle

The evaluator background job follows the same lifecycle pattern as the slow-query alerter:

- `start(store)` — begins the polling loop
- `stop()` — clears the interval timer
- `beginShutdown()` — stops accepting new cycles (called during graceful shutdown)
- `awaitIdle()` — waits for any in-flight evaluation cycle to complete

Wire the evaluator into `src/index.ts` or `src/app.ts` for production use:

```typescript
import { sloThresholdStore } from './services/sloThresholdStore.js';
import { createSloAlertEvaluator } from './services/sloAlertEvaluator.js';
import { env } from './config/env.js';

const sloEvaluator = createSloAlertEvaluator({
  webhookUrl: env.SLO_ALERT_WEBHOOK_URL,
  evalIntervalMs: env.SLO_EVAL_INTERVAL_MS,
});

if (env.SLO_EVAL_INTERVAL_MS > 0) {
  sloEvaluator.start(sloThresholdStore);
}

// Register with shutdown hooks
registerShutdownHook(async () => {
  sloEvaluator.beginShutdown();
  await sloEvaluator.awaitIdle();
});
```

## Error Rate Calculation

The evaluator reads the cumulative `http_requests_total` counter from Prometheus and computes the **lifetime error rate** (5xx responses / total responses) for the route. This is a simplified approach that keeps the evaluator dependency-free. For a true sliding-window error rate in high-traffic environments, consider extending the evaluator to read from a time-series store or a ring-buffer of recent request counts.

## Cardinality

Route labels in SLO metrics use the same parameterised route pattern (`/api/billing/:id`) already emitted by `metricsMiddleware`, so no new high-cardinality label values are introduced.
