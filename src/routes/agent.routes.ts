import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { serviceClient } from '../config/supabase';
import type { TicketView } from '../types/ticket.types';

const router = Router();

/**
 * GET /api/agent/tickets
 * Returns all open/in-progress tickets with joined case and customer data.
 * Requires a valid Bearer token (any authenticated user — agent role is
 * inferred on the frontend by the absence of a customer record).
 */
router.get('/tickets', authMiddleware, async (_req: Request, res: Response): Promise<void> => {
  try {
    const { data, error } = await serviceClient
      .from('tickets')
      .select(`
        ticket_id,
        issue_type,
        ticket_priority,
        ticket_mode,
        status,
        created_at,
        cases (
          case_id,
          summary,
          card_block_status,
          customers (
            full_name,
            email,
            mobile_number,
            segment
          )
        )
      `)
      .in('status', ['open', 'in_progress'])
      .order('created_at', { ascending: true });

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    const tickets: TicketView[] = (data ?? []).map((row: any) => {
      const caseData = Array.isArray(row.cases) ? row.cases[0] : row.cases;
      const customer = caseData
        ? Array.isArray(caseData.customers)
          ? caseData.customers[0]
          : caseData.customers
        : null;

      return {
        ticket_id:          row.ticket_id,
        issue_type:         row.issue_type,
        ticket_priority:    row.ticket_priority,
        ticket_mode:        row.ticket_mode,
        status:             row.status,
        created_at:         row.created_at,
        case_id:            caseData?.case_id   ?? '',
        case_summary:       caseData?.summary   ?? '',
        card_block_status:  caseData?.card_block_status ?? 'not_applicable',
        customer_full_name: customer?.full_name    ?? null,
        customer_email:     customer?.email        ?? '',
        customer_mobile:    customer?.mobile_number ?? null,
        customer_segment:   customer?.segment      ?? null,
      };
    });

    res.json(tickets);
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'Internal server error.' });
  }
});

export default router;
