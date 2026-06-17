import type { Context } from 'hono';
import type { HonoEnv } from '../types';

type Ctx = Context<HonoEnv>;

export function ok(c: Ctx, data?: Record<string, unknown>) {
  return c.json({ ok: true, ...data }, 200);
}

export function created(c: Ctx, data?: Record<string, unknown>) {
  return c.json({ ok: true, ...data }, 201);
}

export function badRequest(c: Ctx, error: string) {
  return c.json({ ok: false, error }, 400);
}

export function unauthorized(c: Ctx, error = 'Unauthorized') {
  return c.json({ ok: false, error }, 401);
}

export function forbidden(c: Ctx, error = 'Forbidden') {
  return c.json({ ok: false, error }, 403);
}

export function notFound(c: Ctx, error = 'Not found') {
  return c.json({ ok: false, error }, 404);
}

export function conflict(c: Ctx, error: string) {
  return c.json({ ok: false, error }, 409);
}

export function rateLimited(c: Ctx, error = 'Too many requests') {
  return c.json({ ok: false, error }, 429);
}

export function serverError(c: Ctx, error = 'Internal server error') {
  return c.json({ ok: false, error }, 500);
}
