import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from './config.js';

const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS']);

export function requestContext(req: Request, res: Response, next: NextFunction): void {
  req.requestId = randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  next();
}

export function hostGuard(req: Request, _res: Response, next: NextFunction): void {
  if (!config.allowedHosts.size) return next();
  const host = String(req.get('host') || '').toLowerCase();
  if (!config.allowedHosts.has(host))
    return next(Object.assign(new Error('Unrecognized host'), { status: 400, code: 'INVALID_HOST' }));
  next();
}

export function httpsGuard(req: Request, res: Response, next: NextFunction): void {
  if (!config.forceHttps || req.secure) return next();
  if (safeMethods.has(req.method) && config.publicUrl) {
    const relative = `/${req.originalUrl.replace(/^\/+/, '')}`;
    const target = new URL(relative, config.publicUrl.origin);
    res.redirect(308, target.toString());
    return;
  }
  next(Object.assign(new Error('HTTPS is required'), { status: 400, code: 'HTTPS_REQUIRED' }));
}

function expectedOrigin(req: Request): string {
  if (config.publicUrl) return config.publicUrl.origin;
  return `${req.protocol}://${req.get('host')}`;
}

export function csrfProtection(req: Request, _res: Response, next: NextFunction): void {
  if (safeMethods.has(req.method)) return next();
  if (req.get('sec-fetch-site') === 'cross-site')
    return next(Object.assign(new Error('Cross-site request blocked'), { status: 403, code: 'CSRF_BLOCKED' }));
  const origin = req.get('origin');
  if (origin && origin !== expectedOrigin(req))
    return next(Object.assign(new Error('Invalid request origin'), { status: 403, code: 'CSRF_BLOCKED' }));
  if (!String(req.get('content-type') || '').toLowerCase().startsWith('application/json'))
    return next(Object.assign(new Error('JSON content type required'), { status: 415, code: 'JSON_REQUIRED' }));
  if (req.user) {
    const token = req.get('x-csrf-token');
    if (!token || token !== req.csrfToken)
      return next(Object.assign(new Error('Invalid CSRF token'), { status: 403, code: 'CSRF_BLOCKED' }));
  }
  next();
}
