/**
 * Admin API (TZ §5, §9 Admin:*). Reachable only with `aud=admin` tokens
 * (enforced in http/auth-context.ts; TOTP is required at admin login for
 * author/editor/superadmin). RBAC: coarse permission per endpoint from the
 * ENDPOINTS table, plus subject / school scope checks in each module.
 */
import type { FastifyInstance } from 'fastify';
import type { Deps } from '../../deps.js';
import { registerAssetAdmin } from './assets.js';
import { registerBuildAdmin } from './builds.js';
import { registerContentAdmin } from './content.js';
import { registerOpsAdmin } from './ops.js';
import { registerOrgAdmin } from './org.js';
import { registerReviewAdmin } from './review.js';
import { registerStringsAdmin } from './strings.js';
import { registerTopicAdmin } from './topics.js';

export function registerAdmin(app: FastifyInstance, deps: Deps) {
  registerContentAdmin(app, deps);
  registerTopicAdmin(app, deps);
  registerAssetAdmin(app, deps);
  registerStringsAdmin(app, deps);
  registerBuildAdmin(app, deps);
  registerOrgAdmin(app, deps);
  registerOpsAdmin(app, deps);
  registerReviewAdmin(app, deps);
}
