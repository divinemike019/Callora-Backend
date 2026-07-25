/**
 * Admin SLO Threshold Router
 *
 * Provides CRUD management for per-route SLO threshold configurations and an
 * on-demand evaluation endpoint.
 *
 * All endpoints require admin authentication (applied by the parent router).
 *
 * Routes exposed (all prefixed with /api/admin/slo):
 *   GET    /thresholds                – list all configured thresholds
 *   POST   /thresholds                – create a new threshold
 *   GET    /thresholds/:id            – fetch a single threshold
 *   PUT    /thresholds/:id            – replace a threshold's mutable fields
 *   DELETE /thresholds/:id            – remove a threshold
 *   POST   /thresholds/evaluate       – trigger an immediate evaluation cycle
 */

import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../middleware/validate.js';
import { BadRequestError, NotFoundError, InternalServerError } from '../../errors/index.js';
import { logger } from '../../logger.js';
import { getClientIp } from '../../lib/clientIp.js';
import type { SloThresholdStore } from '../../services/sloThresholdStore.js';
import { sloThresholdStore as defaultStore } from '../../services/sloThresholdStore.js';
import { createSloAlertEvaluator } from '../../services/sloAlertEvaluator.js';
import type { SloAlertEvaluator } from '../../services/sloAlertEvaluator.js';

const TRUST_PROXY = process.env.TRUST_PROXY_HEADERS === 'true';

// ── Validation schemas ────────────────────────────────────────────────────────

const createThresholdSchema = z.object({
  route: z
    .string()
    .min(1, 'route is required')
    .regex(/^\//, 'route must start with /'),
  errorRateThreshold: z
    .number()
    .min(0, 'errorRateThreshold must be ≥ 0')
    .max(1, 'errorRateThreshold must be ≤ 1'),
  latencyP95Ms: z
    .number()
    .positive('latencyP95Ms must be a positive number'),
  burnWindowSeconds: z
    .number()
    .int()
    .positive('burnWindowSeconds must be a positive integer')
    .optional(),
});

const updateThresholdSchema = z
  .object({
    route: z.string().min(1).regex(/^\//).optional(),
    errorRateThreshold: z.number().min(0).max(1).optional(),
    latencyP95Ms: z.number().positive().optional(),
    burnWindowSeconds: z.number().int().positive().optional(),
  })
  .refine(
    (data) => Object.keys(data).length > 0,
    'At least one field must be provided for update',
  );

const idParamSchema = z.object({
  id: z.string().uuid('id must be a valid UUID'),
});

// ── Deps interface ────────────────────────────────────────────────────────────

export interface AdminSloRouterDeps {
  store?: SloThresholdStore;
  evaluator?: SloAlertEvaluator;
  webhookUrl?: string;
  evalIntervalMs?: number;
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Creates the admin SLO threshold sub-router.
 *
 * @param deps  Optional dep injection for testing.
 */
export function createAdminSloRouter(deps: AdminSloRouterDeps = {}): Router {
  const router = Router();
  const store = deps.store ?? defaultStore;
  const evaluator =
    deps.evaluator ??
    createSloAlertEvaluator({
      webhookUrl: deps.webhookUrl ?? process.env.SLO_ALERT_WEBHOOK_URL,
      evalIntervalMs: deps.evalIntervalMs ?? Number(process.env.SLO_EVAL_INTERVAL_MS ?? '60000'),
    });

  // ── GET /thresholds ───────────────────────────────────────────────────────
  /**
   * List all configured per-route SLO thresholds.
   */
  router.get('/thresholds', (_req, res, next) => {
    try {
      const thresholds = store.list();
      res.json({ data: thresholds, total: thresholds.length });
    } catch (err) {
      logger.error('[adminSlo] list thresholds failed', err);
      next(new InternalServerError());
    }
  });

  // ── POST /thresholds ──────────────────────────────────────────────────────
  /**
   * Create a new per-route SLO threshold configuration.
   */
  router.post(
    '/thresholds',
    validate({ body: createThresholdSchema }),
    (req, res, next) => {
      try {
        const input = req.body as z.infer<typeof createThresholdSchema>;
        const threshold = store.create({
          route: input.route,
          errorRateThreshold: input.errorRateThreshold,
          latencyP95Ms: input.latencyP95Ms,
          burnWindowSeconds: input.burnWindowSeconds,
        });

        logger.audit('CREATE_SLO_THRESHOLD', res.locals.adminActor, {
          clientIp: getClientIp(req, TRUST_PROXY),
          userAgent: req.get('User-Agent'),
          thresholdId: threshold.id,
          route: threshold.route,
        });

        res.status(201).json({ data: threshold });
      } catch (err) {
        if (err instanceof Error && err.message.includes('already exists')) {
          next(new BadRequestError(err.message));
          return;
        }
        logger.error('[adminSlo] create threshold failed', err);
        next(new InternalServerError());
      }
    },
  );

  // ── GET /thresholds/:id ───────────────────────────────────────────────────
  /**
   * Fetch a single threshold by its UUID.
   */
  router.get(
    '/thresholds/:id',
    validate({ params: idParamSchema }),
    (req, res, next) => {
      try {
        const threshold = store.findById(req.params.id);
        if (!threshold) {
          next(new NotFoundError('SLO threshold not found', 'SLO_THRESHOLD_NOT_FOUND'));
          return;
        }
        res.json({ data: threshold });
      } catch (err) {
        logger.error('[adminSlo] get threshold failed', err);
        next(new InternalServerError());
      }
    },
  );

  // ── PUT /thresholds/:id ───────────────────────────────────────────────────
  /**
   * Update mutable fields of an existing threshold.
   */
  router.put(
    '/thresholds/:id',
    validate({ params: idParamSchema, body: updateThresholdSchema }),
    (req, res, next) => {
      try {
        const input = req.body as z.infer<typeof updateThresholdSchema>;
        const updated = store.update(req.params.id, input);

        if (!updated) {
          next(new NotFoundError('SLO threshold not found', 'SLO_THRESHOLD_NOT_FOUND'));
          return;
        }

        logger.audit('UPDATE_SLO_THRESHOLD', res.locals.adminActor, {
          clientIp: getClientIp(req, TRUST_PROXY),
          userAgent: req.get('User-Agent'),
          thresholdId: updated.id,
          route: updated.route,
          diff: input,
        });

        res.json({ data: updated });
      } catch (err) {
        if (err instanceof Error && err.message.includes('already exists')) {
          next(new BadRequestError(err.message));
          return;
        }
        logger.error('[adminSlo] update threshold failed', err);
        next(new InternalServerError());
      }
    },
  );

  // ── DELETE /thresholds/:id ────────────────────────────────────────────────
  /**
   * Remove a threshold by its UUID.
   */
  router.delete(
    '/thresholds/:id',
    validate({ params: idParamSchema }),
    (req, res, next) => {
      try {
        const deleted = store.delete(req.params.id);

        if (!deleted) {
          next(new NotFoundError('SLO threshold not found', 'SLO_THRESHOLD_NOT_FOUND'));
          return;
        }

        logger.audit('DELETE_SLO_THRESHOLD', res.locals.adminActor, {
          clientIp: getClientIp(req, TRUST_PROXY),
          userAgent: req.get('User-Agent'),
          thresholdId: req.params.id,
        });

        res.status(204).end();
      } catch (err) {
        logger.error('[adminSlo] delete threshold failed', err);
        next(new InternalServerError());
      }
    },
  );

  // ── POST /thresholds/evaluate ─────────────────────────────────────────────
  /**
   * Trigger an immediate evaluation of all configured thresholds.
   * Returns the full violation report.
   *
   * This endpoint is separate from the CRUD routes so it never collides
   * with the `:id` param pattern — /evaluate is mounted before /:id in the
   * route list.
   */
  router.post('/thresholds/evaluate', async (req, res, next) => {
    try {
      const thresholds = store.list();

      if (thresholds.length === 0) {
        res.json({
          data: {
            evaluatedAt: new Date().toISOString(),
            routesEvaluated: 0,
            violationsDetected: 0,
            violations: [],
            message: 'No SLO thresholds are configured.',
          },
        });
        return;
      }

      const result = await evaluator.evaluate(thresholds);

      logger.audit('EVALUATE_SLO_THRESHOLDS', res.locals.adminActor, {
        clientIp: getClientIp(req, TRUST_PROXY),
        userAgent: req.get('User-Agent'),
        routesEvaluated: result.routesEvaluated,
        violationsDetected: result.violationsDetected,
      });

      res.json({ data: result });
    } catch (err) {
      logger.error('[adminSlo] evaluate thresholds failed', err);
      next(new InternalServerError());
    }
  });

  return router;
}

export default createAdminSloRouter;
