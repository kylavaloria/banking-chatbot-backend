// ─────────────────────────────────────────────────────────────────────────────
// Chat Routes — updated for Phase 2, Slice 1
// POST /api/chat/message now runs the full orchestration pipeline.
// POST /api/chat/session is unchanged from Phase 1.5.
// ─────────────────────────────────────────────────────────────────────────────

import { Router, Request, Response } from 'express';
import { authMiddleware }             from '../middleware/auth';
import { resolveCustomer }            from '../services/customer.service';
import { getOrCreateActiveSession }   from '../services/session.service';
import { storeMessage }               from '../services/message.service';
import { processMessage }             from '../orchestrator/entry-route';

const router = Router();

// ---------------------------------------------------------------------------
// POST /api/chat/session  (unchanged)
// ---------------------------------------------------------------------------

router.post(
  '/session',
  authMiddleware,
  async (req: Request, res: Response): Promise<void> => {
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
  }
);

// ---------------------------------------------------------------------------
// POST /api/chat/message  (Phase 2 — full orchestration pipeline)
// Body: { messageText: string }
// ---------------------------------------------------------------------------

router.post(
  '/message',
  authMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { authUserId, email } = req.user!;
      const { messageText }       = req.body;

      // ── Input validation ────────────────────────────────────────────────
      if (
        !messageText ||
        typeof messageText !== 'string' ||
        messageText.trim() === ''
      ) {
        res.status(400).json({
          error: 'messageText is required and must be a non-empty string.',
        });
        return;
      }

      const trimmedMessage = messageText.trim();

      // ── Resolve identity + session ──────────────────────────────────────
      const customer = await resolveCustomer(authUserId, email);
      const session  = await getOrCreateActiveSession(customer.customer_id);

      const { customer_id } = customer;
      const { session_id }  = session;

      // ── Persist user message ────────────────────────────────────────────
      // Stored before orchestration so it exists in recent_messages context
      // if the Intent Agent loads history mid-pipeline.
      await storeMessage({
        sessionId:   session_id,
        caseId:      session.current_case_id ?? null,
        senderType:  'user',
        messageText: trimmedMessage,
      });

      // ── Run orchestration pipeline ──────────────────────────────────────
      const result = await processMessage(customer_id, session_id, trimmedMessage);

      // ── Persist assistant reply ─────────────────────────────────────────
      const assistantMessage = await storeMessage({
        sessionId:    session_id,
        caseId:       result.case_id   ?? session.current_case_id ?? null,
        ticketId:     result.ticket_id ?? null,
        senderType:   'assistant',
        messageText:  result.assistant_text,
        responseMode: result.response_mode,
      });

      // ── Stamp message_id onto result ────────────────────────────────────
      result.message_id = assistantMessage.message_id;

      // ── Return response ─────────────────────────────────────────────────
      const responseBody: Record<string, unknown> = {
        sessionId:    session_id,
        messageId:    result.message_id,
        reply:        result.assistant_text,
        responseMode: result.response_mode,
        caseId:       result.case_id   ?? null,
        ticketId:     result.ticket_id ?? null,
      };

      // Include debug payload in non-production environments
      if (process.env.NODE_ENV !== 'production' && result.debug) {
        responseBody['debug'] = result.debug;
      }

      res.json(responseBody);

    } catch (err: any) {
      res.status(err.status ?? 500).json({
        error: err.message ?? 'Internal server error.',
      });
    }
  }
);

export default router;