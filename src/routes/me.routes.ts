import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { resolveCustomer } from '../services/customer.service';

const router = Router();

/**
 * GET /api/me
 * Validates the session token, resolves the customer record
 * (binding on first login if needed), and returns identity.
 */
router.get('/', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    const { authUserId, email } = req.user!;
    const customer = await resolveCustomer(authUserId, email);

    res.json({
      customerId: customer.customer_id,
      email: customer.email,
      fullName: customer.full_name,
      segment: customer.segment,
    });
  } catch (err: any) {
    res.status(err.status ?? 500).json({ error: err.message ?? 'Internal server error.' });
  }
});

export default router;