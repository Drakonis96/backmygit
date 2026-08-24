import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';

export function errorHandler(error: any, req: Request, res: Response, _next: NextFunction): void {
  if (res.headersSent) {
    res.destroy(error);
    return;
  }
  const validation = error instanceof ZodError;
  const status = validation ? 400 : Number(error.status || 500);
  if (status >= 500) console.error(`[${req.requestId}]`, error);
  res.status(status).json({
    error: validation ? 'Validation failed' : error.message || 'Unexpected error',
    code: validation ? 'VALIDATION_ERROR' : error.code,
    details: validation ? error.flatten() : undefined,
    requestId: req.requestId,
  });
}
