import type { AuthenticatedUser } from './auth.js';

declare global {
  namespace Express {
    interface Request {
      requestId: string;
      user?: AuthenticatedUser;
      sessionId?: string;
      csrfToken?: string;
    }
  }
}

export {};
