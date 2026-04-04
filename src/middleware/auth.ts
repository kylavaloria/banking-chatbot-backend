import { Request, Response, NextFunction } from 'express';
import { anonClient } from '../config/supabase';

export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or malformed Authorization header.' });
    return;
  }

  const token = authHeader.split(' ')[1];

  const {
    data: { user },
    error,
  } = await anonClient.auth.getUser(token);

  if (error || !user || !user.email) {
    res.status(401).json({ error: 'Invalid or expired session token.' });
    return;
  }

  req.user = {
    authUserId: user.id,
    email: user.email,
  };

  next();
}