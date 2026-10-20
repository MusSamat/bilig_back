/**
 * Per-request context (AsyncLocalStorage): the journal reads the request id,
 * IP, user agent and the caller (incl. a support session) from here, so every
 * `audit.log(...)` call site gets them without passing them along.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { AuthCtx } from './auth-context.js';

export interface RequestCtx {
  requestId: string;
  ip: string | null;
  userAgent: string | null;
  auth?: AuthCtx;
}

export const requestContext = new AsyncLocalStorage<RequestCtx>();

export const currentRequest = (): RequestCtx | undefined => requestContext.getStore();
