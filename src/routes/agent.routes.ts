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
        emotion_label:      null,
        emotion_intensity:  null,
      };
    });

    // Step 2: batch-fetch the most recent user-message emotion per case.
    const uniqueCaseIds = [...new Set(tickets.map(t => t.case_id).filter(Boolean))];

    if (uniqueCaseIds.length > 0) {
      const { data: emotionData } = await serviceClient
        .from('messages')
        .select('case_id, emotion_label, emotion_intensity, created_at')
        .in('case_id', uniqueCaseIds)
        .eq('sender_type', 'user')
        .not('emotion_label', 'is', null)
        .order('created_at', { ascending: false });

      // Keep only the most-recent emotion row per case_id.
      const emotionMap = new Map<string, { emotion_label: string; emotion_intensity: string | null }>();
      for (const row of (emotionData ?? [])) {
        if (!emotionMap.has(row.case_id)) {
          emotionMap.set(row.case_id, {
            emotion_label:     row.emotion_label,
            emotion_intensity: row.emotion_intensity ?? null,
          });
        }
      }

      for (const ticket of tickets) {
        const entry = emotionMap.get(ticket.case_id);
        if (entry) {
          ticket.emotion_label     = entry.emotion_label;
          ticket.emotion_intensity = entry.emotion_intensity;
        }
      }
    }

    res.json(tickets);
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'Internal server error.' });
  }
});

/**
 * GET /api/agent/analytics/operations
 * Returns ticket volume, issue-type breakdown, response mode distribution,
 * daily trend, top customers, and session summary for the requested period.
 *
 * Query params:
 *   days (number, default 7) — how many days back to analyse
 */
router.get('/analytics/operations', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    const days = Math.min(Math.max(parseInt(String(req.query['days'] ?? '7'), 10) || 7, 1), 90);
    const since = new Date();
    since.setDate(since.getDate() - days);
    const sinceISO = since.toISOString();

    // ── Combined tickets fetch (Q1, Q2, Q4, Q5) ─────────────────────────
    const { data: rawTickets, error: ticketsError } = await serviceClient
      .from('tickets')
      .select('ticket_id, ticket_priority, issue_type, status, created_at')
      .gte('created_at', sinceISO)
      .order('created_at', { ascending: true });

    if (ticketsError) throw { status: 500, message: ticketsError.message };
    const tickets = (rawTickets ?? []) as any[];

    // ── Q3 — Response mode distribution ─────────────────────────────────
    const { data: rawModes } = await serviceClient
      .from('messages')
      .select('response_mode')
      .eq('sender_type', 'assistant')
      .not('response_mode', 'is', null)
      .gte('created_at', sinceISO);

    // ── Q6 — Top customers (join: tickets → cases → customers) ───────────
    const { data: rawTopCustomers } = await serviceClient
      .from('tickets')
      .select(`
        ticket_id,
        ticket_priority,
        cases!inner (
          customer_id,
          customers!inner (
            full_name,
            email,
            segment
          )
        )
      `)
      .gte('created_at', sinceISO);

    // ── Q7 — Session activity ────────────────────────────────────────────
    const { data: rawSessions } = await serviceClient
      .from('chat_sessions')
      .select('session_id, status, created_at')
      .gte('created_at', sinceISO);

    // ── Derive: ticket summary ───────────────────────────────────────────
    const total    = tickets.length;
    const open     = tickets.filter(t => ['open', 'in_progress'].includes(t.status)).length;
    const resolved = tickets.filter(t => t.status === 'resolved').length;
    const closed   = tickets.filter(t => t.status === 'closed').length;

    const priorityMap: Record<string, { total: number; open: number; resolved: number }> = {};
    for (const t of tickets) {
      const p = t.ticket_priority;
      if (!priorityMap[p]) priorityMap[p] = { total: 0, open: 0, resolved: 0 };
      priorityMap[p].total++;
      if (['open', 'in_progress'].includes(t.status)) priorityMap[p].open++;
      if (['resolved', 'closed'].includes(t.status))  priorityMap[p].resolved++;
    }
    const byPriority = Object.entries(priorityMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([priority, c]) => ({ priority, ...c }));

    // ── Derive: issue types ──────────────────────────────────────────────
    const issueMap: Record<string, number> = {};
    for (const t of tickets) {
      if (t.issue_type) issueMap[t.issue_type] = (issueMap[t.issue_type] ?? 0) + 1;
    }
    const topIssueTypes = Object.entries(issueMap)
      .sort(([, a], [, b]) => b - a)
      .map(([issue_type, count]) => ({
        issue_type,
        count,
        percentage: total > 0 ? Math.round((count / total) * 100) : 0,
      }));

    // ── Derive: daily trend ──────────────────────────────────────────────
    const dateMap: Record<string, Record<string, number>> = {};
    for (const t of tickets) {
      const date = t.created_at.slice(0, 10);
      if (!dateMap[date]) dateMap[date] = {};
      dateMap[date][t.ticket_priority] = (dateMap[date][t.ticket_priority] ?? 0) + 1;
    }
    const ticketVolumeTrend = Object.entries(dateMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, byP]) => ({ date, P1: byP['P1'] ?? 0, P2: byP['P2'] ?? 0, P3: byP['P3'] ?? 0 }));

    // ── Derive: response modes ───────────────────────────────────────────
    const modeMap: Record<string, number> = {};
    for (const m of (rawModes ?? []) as any[]) {
      if (m.response_mode) modeMap[m.response_mode] = (modeMap[m.response_mode] ?? 0) + 1;
    }
    const totalModes = Object.values(modeMap).reduce((a, b) => a + b, 0);
    const responseModeDist = Object.entries(modeMap)
      .sort(([, a], [, b]) => b - a)
      .map(([mode, count]) => ({
        mode,
        count,
        percentage: totalModes > 0 ? Math.round((count / totalModes) * 100) : 0,
      }));

    // ── Derive: top customers ────────────────────────────────────────────
    type CustomerEntry = {
      full_name: string; email: string; segment: string | null;
      total: number; p1: number; p2: number; p3: number;
    };
    const customerMap: Record<string, CustomerEntry> = {};
    for (const t of (rawTopCustomers ?? []) as any[]) {
      const cases = Array.isArray(t.cases) ? t.cases : [t.cases];
      for (const c of cases) {
        if (!c?.customer_id) continue;
        const cu = Array.isArray(c.customers) ? c.customers[0] : c.customers;
        if (!cu) continue;
        const id = c.customer_id;
        if (!customerMap[id]) {
          customerMap[id] = {
            full_name: cu.full_name ?? 'Unknown',
            email:     cu.email    ?? '',
            segment:   cu.segment  ?? null,
            total: 0, p1: 0, p2: 0, p3: 0,
          };
        }
        customerMap[id].total++;
        if (t.ticket_priority === 'P1') customerMap[id].p1++;
        if (t.ticket_priority === 'P2') customerMap[id].p2++;
        if (t.ticket_priority === 'P3') customerMap[id].p3++;
      }
    }
    const topCustomers = Object.values(customerMap)
      .sort((a, b) => b.total - a.total)
      .slice(0, 5)
      .map(c => ({
        full_name:     c.full_name,
        email:         c.email,
        segment:       c.segment,
        total_tickets: c.total,
        p1_count:      c.p1,
        p2_count:      c.p2,
        p3_count:      c.p3,
      }));

    // ── Derive: sessions ─────────────────────────────────────────────────
    const allSessions   = (rawSessions ?? []) as any[];
    const totalSessions  = allSessions.length;
    const activeSessions = allSessions.filter((s: any) => s.status === 'active').length;

    res.json({
      period_days:               days,
      ticket_summary:            { total, open, resolved, closed, by_priority: byPriority },
      ticket_volume_trend:       ticketVolumeTrend,
      top_issue_types:           topIssueTypes,
      response_mode_distribution: responseModeDist,
      top_customers:             topCustomers,
      session_summary:           { total_sessions: totalSessions, active_sessions: activeSessions },
    });
  } catch (err: any) {
    res.status(err.status ?? 500).json({ error: err.message ?? 'Internal server error.' });
  }
});

/**
 * GET /api/agent/analytics/emotions
 * Returns emotion distribution, trend, issue-type breakdown, and high-intensity
 * summary across all user messages for the requested period.
 *
 * Query params:
 *   days     (number, default 7)  — how many days back to analyse
 *   priority (string, optional)   — filter tickets by 'P1' | 'P2' | 'P3'
 */
router.get('/analytics/emotions', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    const days     = Math.min(Math.max(parseInt(String(req.query['days'] ?? '7'), 10) || 7, 1), 90);
    const priority = req.query['priority'] as string | undefined;

    const since = new Date();
    since.setDate(since.getDate() - days);
    const sinceISO = since.toISOString();

    // ── Queries 1, 3, 4 ── one fetch covers all three ──────────────────────
    const { data: emotionMessages, error: emotionError } = await serviceClient
      .from('messages')
      .select('emotion_label, emotion_intensity, created_at')
      .eq('sender_type', 'user')
      .not('emotion_label', 'is', null)
      .gte('created_at', sinceISO);

    if (emotionError) throw { status: 500, message: emotionError.message };

    const msgs = emotionMessages ?? [];

    // Query 1 — distribution
    const labelCounts: Record<string, number> = {};
    for (const m of msgs) {
      if (m.emotion_label) labelCounts[m.emotion_label] = (labelCounts[m.emotion_label] ?? 0) + 1;
    }
    const totalMsgs = Object.values(labelCounts).reduce((a, b) => a + b, 0);
    const emotionDistribution = Object.entries(labelCounts).map(([emotion, count]) => ({
      emotion,
      count,
      percentage: totalMsgs > 0 ? Math.round((count / totalMsgs) * 100) : 0,
    }));

    // Query 3 — daily trend
    const dateMap: Record<string, Record<string, number>> = {};
    for (const m of msgs) {
      const date = m.created_at.slice(0, 10);
      if (!dateMap[date]) dateMap[date] = {};
      if (m.emotion_label) dateMap[date][m.emotion_label] = (dateMap[date][m.emotion_label] ?? 0) + 1;
    }
    const emotionTrend = Object.entries(dateMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, e]) => ({
        date,
        angry:      e['angry']      ?? 0,
        frustrated: e['frustrated'] ?? 0,
        anxious:    e['anxious']    ?? 0,
        distressed: e['distressed'] ?? 0,
        neutral:    e['neutral']    ?? 0,
      }));

    // Query 4 — high intensity
    const highMap: Record<string, number> = {};
    for (const m of msgs) {
      if (m.emotion_intensity === 'high' && m.emotion_label) {
        highMap[m.emotion_label] = (highMap[m.emotion_label] ?? 0) + 1;
      }
    }
    const highIntensitySummary = Object.entries(highMap).map(([emotion, count]) => ({ emotion, count }));

    // ── Query 2 — emotion by issue type ────────────────────────────────────
    let ticketQuery = serviceClient
      .from('tickets')
      .select('issue_type, ticket_priority, cases!inner(case_id)')
      .gte('created_at', sinceISO);

    if (priority) ticketQuery = (ticketQuery as any).eq('ticket_priority', priority);

    const { data: tickets } = await ticketQuery;

    const caseToIssue: Record<string, string> = {};
    const caseIds: string[] = [];

    for (const ticket of (tickets ?? []) as any[]) {
      const cases = Array.isArray(ticket.cases) ? ticket.cases : [ticket.cases];
      for (const c of cases) {
        if (c?.case_id) {
          caseToIssue[c.case_id] = ticket.issue_type;
          caseIds.push(c.case_id);
        }
      }
    }

    let issueEmotionMsgs: any[] = [];
    if (caseIds.length > 0) {
      const { data: im } = await serviceClient
        .from('messages')
        .select('case_id, emotion_label')
        .in('case_id', caseIds)
        .eq('sender_type', 'user')
        .not('emotion_label', 'is', null)
        .gte('created_at', sinceISO);
      issueEmotionMsgs = im ?? [];
    }

    const issueMap: Record<string, Record<string, number>> = {};
    for (const m of issueEmotionMsgs) {
      const issue = caseToIssue[m.case_id];
      if (!issue || !m.emotion_label) continue;
      if (!issueMap[issue]) issueMap[issue] = {};
      issueMap[issue][m.emotion_label] = (issueMap[issue][m.emotion_label] ?? 0) + 1;
    }

    const emotionByIssueType = Object.entries(issueMap).map(([issue_type, emotions]) => {
      const dominant = Object.entries(emotions).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'neutral';
      return { issue_type, emotions, dominant_emotion: dominant };
    });

    res.json({
      period_days:             days,
      emotion_distribution:    emotionDistribution,
      emotion_by_issue_type:   emotionByIssueType,
      emotion_trend:           emotionTrend,
      high_intensity_summary:  highIntensitySummary,
      total_messages_analyzed: msgs.length,
    });
  } catch (err: any) {
    res.status(err.status ?? 500).json({ error: err.message ?? 'Internal server error.' });
  }
});

/**
 * GET /api/agent/tickets/:ticketId/conversation
 * Returns message history for this ticket's case only (scoped by case_id),
 * with per-message emotion data. Only user messages carry emotion_label / emotion_intensity.
 */
router.get('/tickets/:ticketId/conversation', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    const { ticketId } = req.params;

    const { data: ticketRow, error: ticketError } = await serviceClient
      .from('tickets')
      .select('case_id')
      .eq('ticket_id', ticketId)
      .maybeSingle();

    if (ticketError || !ticketRow) {
      res.status(404).json({ error: 'Ticket not found.' });
      return;
    }

    const caseId = ticketRow.case_id;

    const { data, error } = await serviceClient
      .from('messages')
      .select(`
        message_id,
        sender_type,
        message_text,
        response_mode,
        emotion_label,
        emotion_intensity,
        created_at
      `)
      .eq('case_id', caseId)
      .order('created_at', { ascending: true });

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    const messages = (data ?? []).sort((a, b) => {
      const timeDiff =
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      if (timeDiff !== 0) return timeDiff;
      if (a.sender_type === 'user' && b.sender_type === 'assistant') return -1;
      if (a.sender_type === 'assistant' && b.sender_type === 'user') return 1;
      return 0;
    });

    res.json({ messages });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'Internal server error.' });
  }
});

export default router;
