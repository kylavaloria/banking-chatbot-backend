import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { resolveCustomer } from '../services/customer.service';
import { getOrCreateActiveSession, linkCaseToSession } from '../services/session.service';
import { createCase, updateCaseStage } from '../services/case.service';
import { createTicket } from '../services/ticket.service';
import { logAction } from '../services/case-action.service';
import { storeMessage } from '../services/message.service';

const router = Router();

/**
 * POST /api/dev/create-demo-case
 *
 * Runs the full stub operational flow:
 *   1. Resolve customer
 *   2. Get or create active session
 *   3. Create case (P3 / standard_ticket)
 *   4. Log create_case action
 *   5. Create ticket under the case
 *   6. Log create_ticket action
 *   7. Update case stage → ticket_created
 *   8. Link session.current_case_id → case
 *   9. Store assistant confirmation message
 *
 * Remove or gate this route before production.
 */
router.post('/create-demo-case', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    const { authUserId, email } = req.user!;

    // Step 1 – Resolve customer
    const customer = await resolveCustomer(authUserId, email);

    // Step 2 – Get or create session
    const session = await getOrCreateActiveSession(customer.customer_id);

    // Step 3 – Create case
    const caseRecord = await createCase({
      customerId: customer.customer_id,
      sessionId: session.session_id,
      primaryIntentType: 'failed_or_delayed_transfer',
      summary: 'Demo: Customer reported a failed or delayed fund transfer.',
      importance: 'medium',
      urgency: 'low',
      priority: 'P3',
      recommendedPath: 'standard_ticket',
    });

    // Step 4 – Log create_case
    await logAction({
      caseId: caseRecord.case_id,
      actionType: 'create_case',
      actionStatus: 'completed',
      actorType: 'system',
      actorName: 'action_agent',
      notes: 'Demo case created via POST /api/dev/create-demo-case.',
      metadataJson: {
        priority: caseRecord.priority,
        recommended_path: caseRecord.recommended_path,
      },
    });

    // Step 5 – Create ticket
    const ticketRecord = await createTicket({
      caseId: caseRecord.case_id,
      issueType: 'failed_or_delayed_transfer',
      ticketPriority: 'P3',
      ticketMode: 'standard_ticket',
      queueName: 'standard-support',
    });

    // Step 6 – Log create_ticket
    await logAction({
      caseId: caseRecord.case_id,
      ticketId: ticketRecord.ticket_id,
      actionType: 'create_ticket',
      actionStatus: 'completed',
      actorType: 'system',
      actorName: 'action_agent',
      notes: 'Demo ticket created under demo case.',
      metadataJson: {
        ticket_priority: ticketRecord.ticket_priority,
        ticket_mode: ticketRecord.ticket_mode,
      },
    });

    // Step 7 – Update case stage → ticket_created
    await updateCaseStage(caseRecord.case_id, 'ticket_created');

    // Step 8 – Link session to case
    await linkCaseToSession(session.session_id, caseRecord.case_id);

    // Step 9 – Store assistant confirmation message
    const confirmationText =
      'Your concern has been logged and a support ticket has been created. ' +
      'A member of our team will review it and follow up with you. Priority: P3 – Standard.';

    await storeMessage({
      sessionId: session.session_id,
      caseId: caseRecord.case_id,
      ticketId: ticketRecord.ticket_id,
      senderType: 'assistant',
      messageText: confirmationText,
      responseMode: 'ticket_confirmation',
    });

    res.status(201).json({
      message: 'Demo case and ticket created successfully.',
      sessionId: session.session_id,
      caseId: caseRecord.case_id,
      ticketId: ticketRecord.ticket_id,
      priority: ticketRecord.ticket_priority,
      stage: 'ticket_created',
    });
  } catch (err: any) {
    res.status(err.status ?? 500).json({ error: err.message ?? 'Internal server error.' });
  }
});

export default router;