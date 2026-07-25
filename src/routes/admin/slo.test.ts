/**
 * Route tests for /api/admin/slo/thresholds
 *
 * Coverage:
 *   - CRUD endpoints: list, create, get, update, delete
 *   - POST /thresholds/evaluate – on-demand evaluation
 *   - Auth guard: 401 for unauthenticated requests
 *   - Validation: 400 for malformed bodies and invalid UUIDs
 *   - Duplicate-route rejection (400)
 *   - 404 for missing threshold IDs
 */

jest.mock('better-sqlite3', () => {
  return class MockDatabase {
    prepare() { return { get: () => null }; }
    exec() {}
    close() {}
  };
});

import express from 'express';
import request from 'supertest';
import { errorHandler } from '../../middleware/errorHandler.js';
import { createAdminSloRouter } from './slo.js';
import { createSloThresholdStore } from '../../services/sloThresholdStore.js';
import { createSloAlertEvaluator } from '../../services/sloAlertEvaluator.js';

// ── App factory ───────────────────────────────────────────────────────────────

function buildApp() {
  const store = createSloThresholdStore();
  const evaluator = createSloAlertEvaluator({ evalIntervalMs: 60_000 });

  const app = express();
  app.use(express.json());

  // Minimal admin auth stub
  app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
    const apiKey = req.headers['x-admin-api-key'];
    if (apiKey === 'test-admin-key') {
      res.locals.adminActor = 'test-admin';
      return next();
    }
    res.status(401).json({ code: 'UNAUTHORIZED', message: 'Unauthorized' });
  });

  app.use('/api/admin/slo', createAdminSloRouter({ store, evaluator }));
  app.use(errorHandler);

  return { app, store, evaluator };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/admin/slo/thresholds', () => {
  it('returns 401 without admin key', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/admin/slo/thresholds');
    expect(res.status).toBe(401);
  });

  it('returns empty list when no thresholds exist', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .get('/api/admin/slo/thresholds')
      .set('x-admin-api-key', 'test-admin-key');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.total).toBe(0);
  });

  it('returns all configured thresholds', async () => {
    const { app, store } = buildApp();
    store.create({ route: '/api/billing', errorRateThreshold: 0.05, latencyP95Ms: 500 });
    store.create({ route: '/api/vault', errorRateThreshold: 0.01, latencyP95Ms: 300 });

    const res = await request(app)
      .get('/api/admin/slo/thresholds')
      .set('x-admin-api-key', 'test-admin-key');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.total).toBe(2);
  });
});

describe('POST /api/admin/slo/thresholds', () => {
  it('creates a threshold and returns 201', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/admin/slo/thresholds')
      .set('x-admin-api-key', 'test-admin-key')
      .send({ route: '/api/billing', errorRateThreshold: 0.05, latencyP95Ms: 500 });

    expect(res.status).toBe(201);
    expect(res.body.data.id).toBeDefined();
    expect(res.body.data.route).toBe('/api/billing');
    expect(res.body.data.errorRateThreshold).toBe(0.05);
    expect(res.body.data.latencyP95Ms).toBe(500);
    expect(res.body.data.burnWindowSeconds).toBe(300);
  });

  it('accepts custom burnWindowSeconds', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/admin/slo/thresholds')
      .set('x-admin-api-key', 'test-admin-key')
      .send({ route: '/api/vault', errorRateThreshold: 0.01, latencyP95Ms: 200, burnWindowSeconds: 120 });

    expect(res.status).toBe(201);
    expect(res.body.data.burnWindowSeconds).toBe(120);
  });

  it('returns 400 when route is missing', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/admin/slo/thresholds')
      .set('x-admin-api-key', 'test-admin-key')
      .send({ errorRateThreshold: 0.05, latencyP95Ms: 500 });
    expect(res.status).toBe(400);
  });

  it('returns 400 when route does not start with /', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/admin/slo/thresholds')
      .set('x-admin-api-key', 'test-admin-key')
      .send({ route: 'api/billing', errorRateThreshold: 0.05, latencyP95Ms: 500 });
    expect(res.status).toBe(400);
  });

  it('returns 400 when errorRateThreshold > 1', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/admin/slo/thresholds')
      .set('x-admin-api-key', 'test-admin-key')
      .send({ route: '/api/billing', errorRateThreshold: 1.5, latencyP95Ms: 500 });
    expect(res.status).toBe(400);
  });

  it('returns 400 when errorRateThreshold < 0', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/admin/slo/thresholds')
      .set('x-admin-api-key', 'test-admin-key')
      .send({ route: '/api/billing', errorRateThreshold: -0.1, latencyP95Ms: 500 });
    expect(res.status).toBe(400);
  });

  it('returns 400 when latencyP95Ms is non-positive', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/admin/slo/thresholds')
      .set('x-admin-api-key', 'test-admin-key')
      .send({ route: '/api/billing', errorRateThreshold: 0.05, latencyP95Ms: 0 });
    expect(res.status).toBe(400);
  });

  it('returns 400 when duplicate route is submitted', async () => {
    const { app } = buildApp();
    const body = { route: '/api/billing', errorRateThreshold: 0.05, latencyP95Ms: 500 };

    await request(app)
      .post('/api/admin/slo/thresholds')
      .set('x-admin-api-key', 'test-admin-key')
      .send(body);

    const res = await request(app)
      .post('/api/admin/slo/thresholds')
      .set('x-admin-api-key', 'test-admin-key')
      .send(body);

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/already exists/);
  });

  it('returns 401 without admin key', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/admin/slo/thresholds')
      .send({ route: '/api/billing', errorRateThreshold: 0.05, latencyP95Ms: 500 });
    expect(res.status).toBe(401);
  });
});

describe('GET /api/admin/slo/thresholds/:id', () => {
  it('returns the threshold for a valid id', async () => {
    const { app, store } = buildApp();
    const t = store.create({ route: '/api/billing', errorRateThreshold: 0.05, latencyP95Ms: 500 });

    const res = await request(app)
      .get(`/api/admin/slo/thresholds/${t.id}`)
      .set('x-admin-api-key', 'test-admin-key');

    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(t.id);
  });

  it('returns 404 for unknown id', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .get('/api/admin/slo/thresholds/00000000-0000-0000-0000-000000000000')
      .set('x-admin-api-key', 'test-admin-key');
    expect(res.status).toBe(404);
  });

  it('returns 400 for non-UUID id', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .get('/api/admin/slo/thresholds/not-a-uuid')
      .set('x-admin-api-key', 'test-admin-key');
    expect(res.status).toBe(400);
  });
});

describe('PUT /api/admin/slo/thresholds/:id', () => {
  it('updates the threshold and returns the new values', async () => {
    const { app, store } = buildApp();
    const t = store.create({ route: '/api/billing', errorRateThreshold: 0.05, latencyP95Ms: 500 });

    const res = await request(app)
      .put(`/api/admin/slo/thresholds/${t.id}`)
      .set('x-admin-api-key', 'test-admin-key')
      .send({ latencyP95Ms: 800 });

    expect(res.status).toBe(200);
    expect(res.body.data.latencyP95Ms).toBe(800);
    expect(res.body.data.errorRateThreshold).toBe(0.05);
  });

  it('returns 404 for unknown id', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .put('/api/admin/slo/thresholds/00000000-0000-0000-0000-000000000000')
      .set('x-admin-api-key', 'test-admin-key')
      .send({ latencyP95Ms: 800 });
    expect(res.status).toBe(404);
  });

  it('returns 400 when body is empty', async () => {
    const { app, store } = buildApp();
    const t = store.create({ route: '/api/billing', errorRateThreshold: 0.05, latencyP95Ms: 500 });

    const res = await request(app)
      .put(`/api/admin/slo/thresholds/${t.id}`)
      .set('x-admin-api-key', 'test-admin-key')
      .send({});
    expect(res.status).toBe(400);
  });

  it('returns 400 when route collision would be created', async () => {
    const { app, store } = buildApp();
    const a = store.create({ route: '/api/billing', errorRateThreshold: 0.05, latencyP95Ms: 500 });
    store.create({ route: '/api/vault', errorRateThreshold: 0.02, latencyP95Ms: 300 });

    const res = await request(app)
      .put(`/api/admin/slo/thresholds/${a.id}`)
      .set('x-admin-api-key', 'test-admin-key')
      .send({ route: '/api/vault' });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/already exists/);
  });
});

describe('DELETE /api/admin/slo/thresholds/:id', () => {
  it('returns 204 on successful deletion', async () => {
    const { app, store } = buildApp();
    const t = store.create({ route: '/api/billing', errorRateThreshold: 0.05, latencyP95Ms: 500 });

    const res = await request(app)
      .delete(`/api/admin/slo/thresholds/${t.id}`)
      .set('x-admin-api-key', 'test-admin-key');

    expect(res.status).toBe(204);
    expect(store.findById(t.id)).toBeUndefined();
  });

  it('returns 404 for unknown id', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .delete('/api/admin/slo/thresholds/00000000-0000-0000-0000-000000000000')
      .set('x-admin-api-key', 'test-admin-key');
    expect(res.status).toBe(404);
  });

  it('returns 400 for non-UUID id', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .delete('/api/admin/slo/thresholds/bad-id')
      .set('x-admin-api-key', 'test-admin-key');
    expect(res.status).toBe(400);
  });
});

describe('POST /api/admin/slo/thresholds/evaluate', () => {
  it('returns empty result with message when no thresholds configured', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/admin/slo/thresholds/evaluate')
      .set('x-admin-api-key', 'test-admin-key');

    expect(res.status).toBe(200);
    expect(res.body.data.routesEvaluated).toBe(0);
    expect(res.body.data.violationsDetected).toBe(0);
    expect(res.body.data.violations).toEqual([]);
    expect(res.body.data.message).toBeDefined();
  });

  it('runs evaluation and returns structured result', async () => {
    const { app, store } = buildApp();
    store.create({ route: '/api/billing', errorRateThreshold: 0.05, latencyP95Ms: 500 });

    const res = await request(app)
      .post('/api/admin/slo/thresholds/evaluate')
      .set('x-admin-api-key', 'test-admin-key');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('evaluatedAt');
    expect(res.body.data).toHaveProperty('routesEvaluated');
    expect(res.body.data).toHaveProperty('violationsDetected');
    expect(res.body.data).toHaveProperty('violations');
    // No real metrics in test env → 0 violations
    expect(res.body.data.violationsDetected).toBe(0);
  });

  it('returns 401 without admin key', async () => {
    const { app } = buildApp();
    const res = await request(app).post('/api/admin/slo/thresholds/evaluate');
    expect(res.status).toBe(401);
  });
});
