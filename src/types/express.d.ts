// Augments the Express Request type so req.user is available
// after the auth middleware runs.
import 'express';

declare global {
  namespace Express {
    interface Request {
      user?: {
        authUserId: string;
        email: string;
      };
    }
  }
}