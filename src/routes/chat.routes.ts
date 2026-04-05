// ─────────────────────────────────────────────────────────────────────────────
// Chat Routes — Phase 2, Slice 2 update
// Only change: processMessage now receives persistFn
// ─────────────────────────────────────────────────────────────────────────────

import { Router, Request, Response } from 'express';
import { authMiddleware }             from '../middleware/auth';
import { resolveCustomer }            from '../services/customer.service';
import { getOrCreateActiveSession }   from '../services/session.service';
import { storeMessage }               from '../services/message.service';
import { processMessage }             from '../orchestrator/entry-route';

const router = Router();

router.post('/session', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    const { authUserId, email } = req.user!;
    const customer = await resolveCustomer(authUserId, email);
    const session  = await getOrCreateActiveSession(customer.customer_id);
    res.json({
      sessionId:     session.session_id,
      status:        session.session_status,
      currentCaseId: session.current_case_id,
      startedAt:     session.started_at,
    });
  } catch (err: any) {
    res.status(err.status ?? 500).json({ error: err.message ?? 'Internal server error.' });
  }
});

router.post('/message', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    const { authUserId, email } = req.user!;
    const { messageText }       = req.body;

    if (!messageText || typeof messageText !== 'string' || messageText.trim() === '') {
      res.status(400).json({ error: 'messageText is required and must be a non-empty string.' });
      return;
    }

    const trimmedMessage = messageText.trim();
    const customer = await resolveCustomer(authUserId, email);
    const session  = await getOrCreateActiveSession(customer.customer_id);

    const { customer_id } = customer;
    const { session_id }  = session;

    // Persist user message before orchestration
    await storeMessage({
      sessionId:   session_id,
      caseId:      session.current_case_id ?? null,
      senderType:  'user',
      messageText: trimmedMessage,
    });

    // persistFn passed to entry-route so card-block branch can store its reply
    const persistFn = async (params: {
      sessionId:    string;
      caseId:       string | null;
      ticketId?:    string | null;
      senderType:   'user' | 'assistant' | 'system';
      messageText:  string;
      responseMode?: string | null;
    }) => {
      return storeMessage({
        sessionId:    params.sessionId,
        caseId:       params.caseId,
        ticketId:     params.ticketId ?? null,
        senderType:   params.senderType,
        messageText:  params.messageText,
        responseMode: (params.responseMode as any) ?? null,
      });
    };

    const result = await processMessage(customer_id, session_id, trimmedMessage, persistFn);

    // Persist assistant reply for non-card-block branches
    // (card-block branch persists its own reply inside entry-route via persistFn)
    if (!result.message_id) {
      const assistantMessage = await storeMessage({
        sessionId:    session_id,
        caseId:       result.case_id   ?? session.current_case_id ?? null,
        ticketId:     result.ticket_id ?? null,
        senderType:   'assistant',
        messageText:  result.assistant_text,
        responseMode: result.response_mode,
      });
      result.message_id = assistantMessage.message_id;
    }

    const responseBody: Record<string, unknown> = {
      sessionId:    session_id,
      messageId:    result.message_id,
      reply:        result.assistant_text,
      responseMode: result.response_mode,
      caseId:       result.case_id   ?? null,
      ticketId:     result.ticket_id ?? null,
    };

    if (process.env.NODE_ENV !== 'production' && result.debug) {
      responseBody['debug'] = result.debug;
    }

    res.json(responseBody);
  } catch (err: any) {
    res.status(err.status ?? 500).json({ error: err.message ?? 'Internal server error.' });
  }
});

export default router;