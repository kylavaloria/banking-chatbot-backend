import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { Request } from 'express';

const windowMs = 60 * 1000; // 1 minute

const jsonMessage = (msg: string) => ({ error: msg });

// Global fallback — catches anything not covered by a route-specific limiter.
// Keyed by IP since no auth context is guaranteed at this level.
export const globalLimiter = rateLimit({
  windowMs,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: jsonMessage('Too many requests. Please try again later.'),
});

// POST /api/chat/message — triggers LLM orchestration, most expensive endpoint.
// Runs after authMiddleware so req.user is populated; falls back to IP for safety.
export const chatMessageLimiter = rateLimit({
  windowMs,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => req.user?.authUserId ?? ipKeyGenerator(req.ip ?? ''),
  message: jsonMessage('Message rate limit exceeded. Please wait before sending more messages.'),
});

// POST /api/chat/session — lightweight but spammable; keyed by user after auth.
export const chatSessionLimiter = rateLimit({
  windowMs,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => req.user?.authUserId ?? ipKeyGenerator(req.ip ?? ''),
  message: jsonMessage('Too many session requests. Please try again later.'),
});

// GET /api/agent/* — dashboard reads; less costly but still bounded per user.
export const agentLimiter = rateLimit({
  windowMs,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => req.user?.authUserId ?? ipKeyGenerator(req.ip ?? ''),
  message: jsonMessage('Too many agent dashboard requests. Please try again later.'),
});

// POST /api/dev/* — dev/test utilities; tightly capped regardless of environment.
export const devLimiter = rateLimit({
  windowMs,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: jsonMessage('Dev endpoint rate limit exceeded.'),
});
