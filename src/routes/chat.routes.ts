// ─────────────────────────────────────────────────────────────────────────────
// Chat Routes — Phase 2, Slice 2 update
// Only change: processMessage now receives persistFn
// ─────────────────────────────────────────────────────────────────────────────

import { Router, Request, Response } from 'express';
import { authMiddleware }             from '../middleware/auth';
import { serviceClient }              from '../config/supabase';
import { resolveCustomer }            from '../services/customer.service';
import { getOrCreateActiveSession }   from '../services/session.service';
import { storeMessage }               from '../services/message.service';
import { processMessage }             from '../orchestrator/entry-route';

interface TicketDetail {
  ticket_id:   string;
  issue_type:  string;
  status:      string;
  summary:     string;
}

async function fetchTicketDetails(
  ticketIds: string[]
): Promise<TicketDetail[]> {
  if (!ticketIds || ticketIds.length === 0) return [];

  const { data, error } = await serviceClient
    .from('tickets')
    .select(`
      ticket_id,
      issue_type,
      status,
      cases ( summary )
    `)
    .in('ticket_id', ticketIds);

  if (error || !data) return [];

  return data.map((row: any) => ({
    ticket_id:  row.ticket_id,
    issue_type: row.issue_type,
    status:     row.status,
    summary:    row.cases?.summary ?? '',
  }));
}

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

// GET /api/chat/messages — returns message history for the active session
router.get('/messages', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    const { authUserId, email } = req.user!;
    const customer = await resolveCustomer(authUserId, email);
    const session  = await getOrCreateActiveSession(customer.customer_id);

    const { data, error } = await serviceClient
      .from('messages')
      .select('message_id, sender_type, message_text, response_mode, case_id, ticket_id, created_at')
      .eq('session_id', session.session_id)
      .order('created_at', { ascending: true })
      .limit(50); // last 50 messages

    if (error) throw { status: 500, message: 'Failed to load message history.' };

    res.json({
      sessionId: session.session_id,
      messages:  data ?? [],
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

    // Persist user message before orchestration (emotion columns updated after pipeline)
    const userMessage = await storeMessage({
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

    // Backfill case_id on the user message when it was stored before the case existed
    // (first message of a new case has case_id = null at insert time).
    if (!session.current_case_id && result.case_id) {
      await serviceClient
        .from('messages')
        .update({ case_id: result.case_id })
        .eq('message_id', userMessage.message_id)
        .then(({ error }) => {
          if (error) console.warn('[chat.routes] Failed to backfill case_id on user message:', error.message);
        });
    }

    // Update user message row with emotion data if available
    if (result.emotion_label) {
      await serviceClient
        .from('messages')
        .update({
          emotion_label:     result.emotion_label,
          emotion_intensity: result.emotion_intensity ?? null,
        })
        .eq('message_id', userMessage.message_id)
        .then(({ error }) => {
          if (error) console.warn('[chat.routes] Failed to update emotion on user message:', error.message);
        });
    }

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

    const allTicketIds = result.ticket_ids?.length
      ? result.ticket_ids
      : result.ticket_id
        ? [result.ticket_id]
        : [];

    const ticketDetails = await fetchTicketDetails(allTicketIds);

    const responseBody: Record<string, unknown> = {
      sessionId:     session_id,
      messageId:     result.message_id,
      reply:         result.assistant_text,
      responseMode:  result.response_mode,
      caseId:        result.case_id   ?? null,
      ticketId:      result.ticket_id ?? null,
      ticketIds:     result.ticket_ids ?? [],
      tickets:       ticketDetails,
    };

    if (process.env.NODE_ENV !== 'production' && result.debug) {
      responseBody['debug'] = result.debug;
    }

    res.json(responseBody);
  } catch (err: any) {
    res.status(err.status ?? 500).json({ error: err.message ?? 'Internal server error.' });
  }
});

// GET /api/chat/tickets?caseIds=id1,id2,id3
router.get('/tickets', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    const raw = req.query['caseIds'];
    if (!raw || typeof raw !== 'string') {
      res.json({ tickets: [] });
      return;
    }

    const caseIds = raw.split(',').map(s => s.trim()).filter(Boolean);
    if (caseIds.length === 0) {
      res.json({ tickets: [] });
      return;
    }

    const { data, error } = await serviceClient
      .from('tickets')
      .select(`
        ticket_id,
        case_id,
        issue_type,
        status,
        cases ( summary )
      `)
      .in('case_id', caseIds);

    if (error) throw { status: 500, message: 'Failed to fetch ticket details.' };

    const tickets = (data ?? []).map((row: any) => ({
      ticket_id:  row.ticket_id,
      case_id:    row.case_id,
      issue_type: row.issue_type,
      status:     row.status,
      summary:    row.cases?.summary ?? '',
    }));

    res.json({ tickets });
  } catch (err: any) {
    res.status(err.status ?? 500).json({ error: err.message ?? 'Internal server error.' });
  }
});

export default router;