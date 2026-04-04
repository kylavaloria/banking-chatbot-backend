import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { resolveCustomer } from '../services/customer.service';
import { getOrCreateActiveSession } from '../services/session.service';
import { storeMessage } from '../services/message.service';

const router = Router();

/**
 * POST /api/chat/session
 * Returns an existing active session or creates a new one
 * for the authenticated customer.
 */
router.post('/session', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    const { authUserId, email } = req.user!;

    const customer = await resolveCustomer(authUserId, email);
    const session = await getOrCreateActiveSession(customer.customer_id);

    res.json({
      sessionId: session.session_id,
      status: session.session_status,
      currentCaseId: session.current_case_id,
      startedAt: session.started_at,
    });
  } catch (err: any) {
    res.status(err.status ?? 500).json({ error: err.message ?? 'Internal server error.' });
  }
});

/**
 * POST /api/chat/message
 * Body: { messageText: string }
 *
 * Stores the user message, generates a stub assistant reply,
 * and returns the reply with its message ID.
 */
router.post('/message', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    const { authUserId, email } = req.user!;
    const { messageText } = req.body;

    if (!messageText || typeof messageText !== 'string' || messageText.trim() === '') {
      res.status(400).json({ error: 'messageText is required and must be a non-empty string.' });
      return;
    }

    const customer = await resolveCustomer(authUserId, email);
    const session = await getOrCreateActiveSession(customer.customer_id);

    // Persist the user's message.
    await storeMessage({
      sessionId: session.session_id,
      caseId: session.current_case_id,
      senderType: 'user',
      messageText: messageText.trim(),
    });

    // Stub: in Phase 2 this is replaced by the Conversation Manager pipeline.
    const stubReply =
      'Thank you for reaching out. Our team is reviewing your message and will respond shortly.';

    const assistantMessage = await storeMessage({
      sessionId: session.session_id,
      caseId: session.current_case_id,
      senderType: 'assistant',
      messageText: stubReply,
      responseMode: 'informational',
    });

    res.json({
      sessionId: session.session_id,
      reply: stubReply,
      messageId: assistantMessage.message_id,
    });
  } catch (err: any) {
    res.status(err.status ?? 500).json({ error: err.message ?? 'Internal server error.' });
  }
});

export default router;