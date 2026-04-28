// ─────────────────────────────────────────────────────────────────────────────
// tests/flows.integration.test.ts
// 10-flow accuracy test covering all priority tiers, emotion arcs,
// and key agent behaviors described in the test plan.
//
// Run: npx vitest run tests/flows.integration.test.ts
// Prerequisites: backend running on localhost:3000, valid TEST_USER credentials
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeAll, afterEach, beforeEach } from 'vitest';

const BASE = 'http://localhost:3000';
let token  = '';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function getToken(): Promise<string> {
  const res = await fetch(
    `${process.env.SUPABASE_URL}/auth/v1/token?grant_type=password`,
    {
      method:  'POST',
      headers: {
        'apikey':       process.env.SUPABASE_ANON_KEY!,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email:    process.env.TEST_USER_EMAIL,
        password: process.env.TEST_USER_PASSWORD,
      }),
    }
  );
  const data = await res.json() as any;
  if (!data.access_token) throw new Error('Could not get token: ' + JSON.stringify(data));
  return data.access_token;
}

async function chat(messageText: string): Promise<any> {
  const res = await fetch(`${BASE}/api/chat/message`, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({ messageText }),
  });
  return res.json();
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function resetSession(): Promise<void> {
  await fetch(`${BASE}/api/dev/reset-session`, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${token}` },
  });
  await sleep(1000);
}

// ─────────────────────────────────────────────────────────────────────────────
// Setup
// ─────────────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  token = await getToken();
  await resetSession();
});

afterEach(async () => {
  await sleep(4000); // rate limit buffer between messages
});

// ─────────────────────────────────────────────────────────────────────────────
// Flow 1 — Informational / Neutral flat / Pure RAG pipeline
// ─────────────────────────────────────────────────────────────────────────────

describe('Flow 1 — Informational: customer researching savings account', () => {
  beforeAll(async () => { await resetSession(); });

  it('[F1-1] asks about savings account types → informational, no ticket', async () => {
    const r = await chat('Hi, what types of savings accounts do you offer?');
    expect(r.responseMode).toBe('informational');
    expect(r.caseId).toBeFalsy();
    expect(r.ticketId).toBeFalsy();
    expect(r.reply.length).toBeGreaterThan(20);
  });

  it('[F1-2] asks about minimum balance → informational, no ticket', async () => {
    const r = await chat('What is the minimum balance required?');
    expect(r.responseMode).toBe('informational');
    expect(r.caseId).toBeFalsy();
  });

  it('[F1-3] asks about maintaining balance → informational, no ticket', async () => {
    const r = await chat('How much is the maintaining balance for the basic savings?');
    expect(r.responseMode).toBe('informational');
    expect(r.caseId).toBeFalsy();
  });

  it('[F1-4] asks about valid IDs → informational, no ticket', async () => {
    const r = await chat('What valid IDs do I need to open an account?');
    expect(r.responseMode).toBe('informational');
    expect(r.caseId).toBeFalsy();
  });

  it('[F1-5] asks about branch hours → informational, no ticket', async () => {
    const r = await chat('What are your branch hours?');
    expect(r.responseMode).toBe('informational');
    expect(r.caseId).toBeFalsy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Flow 2 — P3 / Neutral → Anxious / Emotion shift detection
// ─────────────────────────────────────────────────────────────────────────────

describe('Flow 2 — P3 refund: neutral then anxious', () => {
  beforeAll(async () => { await resetSession(); });

  it('[F2-1] reports refund not yet received → P3 ticket, neutral', async () => {
    const r = await chat('I returned an item last week and I was told the refund will be credited within 5 days');
    expect(r.responseMode).toBe('ticket_confirmation');
    expect(r.caseId).toBeTruthy();
    expect(r.ticketId).toBeTruthy();
  });

  it('[F2-2] follow-up after 7 days → same case, no new ticket', async () => {
    const r = await chat('It has been 7 days and I still don\'t see it in my account');
    expect(r.caseId).toBeTruthy();
    expect(r.ticketId).toBeFalsy(); // follow-up, not new ticket
    expect(r.reply.length).toBeGreaterThan(20);
  });

  it('[F2-3] expresses worry → same case, anxious emotion, no new ticket', async () => {
    const r = await chat('I\'m starting to get worried, what if it doesn\'t come back?');
    expect(r.caseId).toBeTruthy();
    expect(r.ticketId).toBeFalsy();
    expect(r.reply.length).toBeGreaterThan(20);
  });

  it('[F2-4] escalates anxiety → same case, no new ticket, empathetic reply', async () => {
    const r = await chat('Please help me, I don\'t know what to do if the money is lost');
    expect(r.caseId).toBeTruthy();
    expect(r.ticketId).toBeFalsy();
    expect(r.reply.toLowerCase()).toMatch(/understand|sorry|team|working|case/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Flow 3 — P3 / Neutral → Frustrated / Frustration keywords
// ─────────────────────────────────────────────────────────────────────────────

describe('Flow 3 — P3 failed transfer: neutral then frustrated', () => {
  beforeAll(async () => { await resetSession(); });

  it('[F3-1] reports failed transfer → P3 ticket created', async () => {
    const r = await chat('I sent money to my brother last Monday and he still hasn\'t received it');
    expect(r.responseMode).toBe('ticket_confirmation');
    expect(r.caseId).toBeTruthy();
    expect(r.ticketId).toBeTruthy();
  });

  it('[F3-2] already called yesterday → same case, no new ticket', async () => {
    const r = await chat('I already called yesterday and they said to wait but it\'s still not there');
    expect(r.caseId).toBeTruthy();
    expect(r.ticketId).toBeFalsy();
  });

  it('[F3-3] second time happening → same case, no new ticket', async () => {
    const r = await chat('This is already the second time this has happened to me');
    expect(r.caseId).toBeTruthy();
    expect(r.ticketId).toBeFalsy();
  });

  it('[F3-4] high frustration → same case, no new ticket, reply acknowledges', async () => {
    const r = await chat('How many times do I have to follow up? Nothing has happened');
    expect(r.caseId).toBeTruthy();
    expect(r.ticketId).toBeFalsy();
    expect(r.reply.toLowerCase()).toMatch(/frustrat|understand|working|case|team/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Flow 4 — P2 / Neutral → Anxious / Account access issue
// ─────────────────────────────────────────────────────────────────────────────

describe('Flow 4 — P2 account locked: neutral then anxious', () => {
  beforeAll(async () => { await resetSession(); });

  it('[F4-1] can\'t log in → P2 ticket, account_access_issue', async () => {
    const r = await chat('I can\'t log in to my online banking, it says my account is locked');
    expect(['ticket_confirmation', 'critical_action_confirmation']).toContain(r.responseMode);
    expect(r.caseId).toBeTruthy();
    expect(r.ticketId).toBeTruthy();
  });

  it('[F4-2] tried for 30 minutes → same case, no new ticket', async () => {
    const r = await chat('I\'ve been trying for 30 minutes now and I can\'t get in');
    expect(r.caseId).toBeTruthy();
    expect(r.ticketId).toBeFalsy();
  });

  it('[F4-3] needs to pay bills today → same case, no new ticket', async () => {
    const r = await chat('I\'m worried because I need to pay my bills today');
    expect(r.caseId).toBeTruthy();
    expect(r.ticketId).toBeFalsy();
  });

  it('[F4-4] expresses desperation → same case, no new ticket, reassuring reply', async () => {
    const r = await chat('Please help me, I don\'t know what will happen if I can\'t access it');
    expect(r.caseId).toBeTruthy();
    expect(r.ticketId).toBeFalsy();
    expect(r.reply.toLowerCase()).toMatch(/understand|sorry|team|working|help/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Flow 5 — P2 / Neutral → Distressed / Hardship keywords
// ─────────────────────────────────────────────────────────────────────────────

describe('Flow 5 — P2 account restricted: neutral then distressed', () => {
  beforeAll(async () => { await resetSession(); });

  it('[F5-1] account restricted → P2 ticket', async () => {
    const r = await chat('My account has been restricted and I cannot make any transactions');
    expect(['ticket_confirmation', 'critical_action_confirmation']).toContain(r.responseMode);
    expect(r.caseId).toBeTruthy();
    expect(r.ticketId).toBeTruthy();
  });

  it('[F5-2] child needs medicine → same case, distress detected, no new ticket', async () => {
    const r = await chat('I need to pay for my child\'s medicine today');
    expect(r.caseId).toBeTruthy();
    expect(r.ticketId).toBeFalsy();
    expect(r.reply.length).toBeGreaterThan(20);
  });

  it('[F5-3] only account available → same case, no new ticket', async () => {
    const r = await chat('I have no other account, this is the only way I can access my money');
    expect(r.caseId).toBeTruthy();
    expect(r.ticketId).toBeFalsy();
  });

  it('[F5-4] family depends on this → same case, empathetic reply', async () => {
    const r = await chat('My family depends on this, please help me resolve this as soon as possible');
    expect(r.caseId).toBeTruthy();
    expect(r.ticketId).toBeFalsy();
    expect(r.reply.toLowerCase()).toMatch(/understand|sorry|priority|team|working/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Flow 6 — P1 / Anxious → Angry / Unauthorized transaction
// ─────────────────────────────────────────────────────────────────────────────

describe('Flow 6 — P1 unauthorized transaction: anxious then angry', () => {
  beforeAll(async () => { await resetSession(); });

  it('[F6-1] spots unauthorized transactions → P1 critical', async () => {
    const r = await chat('I just checked my account and there are transactions I did not make');
    expect(r.responseMode).toBe('critical_action_confirmation');
    expect(r.caseId).toBeTruthy();
    expect(r.ticketId).toBeTruthy();
  });

  it('[F6-2] specifies amount → same case, no new ticket', async () => {
    const r = await chat('Someone charged 3,500 pesos on my credit card and it was not me');
    expect(r.caseId).toBeTruthy();
    expect(r.ticketId).toBeFalsy();
  });

  it('[F6-3] questions how it happened → same case, no new ticket', async () => {
    const r = await chat('Why is this happening? I never shared my card details with anyone');
    expect(r.caseId).toBeTruthy();
    expect(r.ticketId).toBeFalsy();
  });

  it('[F6-4] expresses high anger → same case, no new ticket, apology in reply', async () => {
    const r = await chat('This is unacceptable, where is my money and why is no one stopping this');
    expect(r.caseId).toBeTruthy();
    expect(r.ticketId).toBeFalsy();
    expect(r.reply.toLowerCase()).toMatch(/sorry|apologize|understand|urgent|team/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Flow 7 — P1 / Neutral → Angry / Card block flow + fraud
// ─────────────────────────────────────────────────────────────────────────────

describe('Flow 7 — P1 lost card: card block flow then fraud anger', () => {
  beforeAll(async () => { await resetSession(); });

  it('[F7-1] reports lost debit card → P1, card block offered', async () => {
    const r = await chat('I lost my debit card, I need to report it immediately');
    expect(r.responseMode).toBe('critical_action_confirmation');
    expect(r.caseId).toBeTruthy();
    expect(r.ticketId).toBeTruthy();
    expect(r.reply.toLowerCase()).toMatch(/block|yes|no/);
  });

  it('[F7-2] confirms card block with YES → block confirmed', async () => {
    const r = await chat('Yes please block my card');
    expect(r.responseMode).toBe('critical_action_confirmation');
    expect(r.caseId).toBeTruthy();
    expect(r.reply.toLowerCase()).toMatch(/block|confirmed|protected/);
  });

  it('[F7-3] reports unauthorized transaction → same case or new P1, no P3 ticket', async () => {
    const r = await chat('I also just saw a transaction I did not make, someone already used my card');
    expect(r.caseId).toBeTruthy();
    // Should NOT downgrade to P3
    expect(r.responseMode).not.toBe('ticket_confirmation');
  });

  it('[F7-4] expresses anger with BSP threat → reply contains apology', async () => {
    const r = await chat('This is ridiculous and unacceptable, I will file a BSP complaint if this is not resolved');
    expect(r.caseId).toBeTruthy();
    expect(r.reply.toLowerCase()).toMatch(/sorry|apologize|understand|urgent|priority/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Flow 8 — P3 Hybrid / Neutral flat / Hybrid classification
// ─────────────────────────────────────────────────────────────────────────────

describe('Flow 8 — Hybrid: informational question + operational concern', () => {
  beforeAll(async () => { await resetSession(); });

  it('[F8-1] hybrid message → operational ticket created, reply covers both', async () => {
    const r = await chat('What is your refund policy, and also my refund has not been processed yet');
    expect(r.caseId).toBeTruthy();
    expect(r.ticketId).toBeTruthy();
    expect(r.reply.length).toBeGreaterThan(50);
  });

  it('[F8-2] asks how long to wait → informational follow-up, no new ticket', async () => {
    const r = await chat('How long does it usually take before I should be concerned?');
    expect(r.ticketId).toBeFalsy();
    expect(r.reply.length).toBeGreaterThan(20);
  });

  it('[F8-3] confirms problem after 14 days → same case updated, no new ticket', async () => {
    const r = await chat('Okay it\'s been 14 days already so I think there is really a problem');
    expect(r.caseId).toBeTruthy();
    expect(r.ticketId).toBeFalsy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Flow 9 — Refusal → P3 / Neutral flat / Out-of-scope then legitimate
// ─────────────────────────────────────────────────────────────────────────────

describe('Flow 9 — Refusal then legitimate concern', () => {
  beforeAll(async () => { await resetSession(); });

  it('[F9-1] asks for Python script → refusal, no ticket', async () => {
    const r = await chat('Can you write me a Python script?');
    expect(r.responseMode).toBe('refusal');
    expect(r.caseId).toBeFalsy();
    expect(r.ticketId).toBeFalsy();
  });

  it('[F9-2] asks about loan products → informational, no ticket', async () => {
    const r = await chat('Okay fine. Can you tell me about your loan products?');
    expect(r.responseMode).toBe('informational');
    expect(r.caseId).toBeFalsy();
  });

  it('[F9-3] reports double loan payment → P3 ticket created', async () => {
    const r = await chat('Actually I have a problem, I was charged twice for my loan payment this month');
    expect(r.responseMode).toBe('ticket_confirmation');
    expect(r.caseId).toBeTruthy();
    expect(r.ticketId).toBeTruthy();
  });

  it('[F9-4] expresses urgency → same case, no new ticket', async () => {
    const r = await chat('I need it reversed urgently, I have bills to pay');
    expect(r.caseId).toBeTruthy();
    expect(r.ticketId).toBeFalsy();
    expect(r.reply.length).toBeGreaterThan(20);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Flow 10 — P2 → P1 / Neutral → Distressed / Topic switch + extreme distress
// ─────────────────────────────────────────────────────────────────────────────

describe('Flow 10 — Topic switch: P2 account suspended escalates to P1 fraud', () => {
  beforeAll(async () => { await resetSession(); });

  let firstCaseId: string | null = null;

  it('[F10-1] account suspended, can\'t access salary → P2 ticket', async () => {
    const r = await chat('My account has been suspended and I cannot withdraw my salary');
    expect(['ticket_confirmation', 'critical_action_confirmation']).toContain(r.responseMode);
    expect(r.caseId).toBeTruthy();
    expect(r.ticketId).toBeTruthy();
    firstCaseId = r.caseId;
  });

  it('[F10-2] reveals hardship → same case updated, no new ticket', async () => {
    const r = await chat('I have no money left and my children need food, please help me');
    expect(r.caseId).toBeTruthy();
    expect(r.ticketId).toBeFalsy();
  });

  it('[F10-3] introduces fraud — topic switch → NEW P1 case created', async () => {
    const r = await chat('Someone also told me there were transactions I didn\'t make on my account');
    expect(r.responseMode).toBe('critical_action_confirmation');
    expect(r.caseId).toBeTruthy();
    // New case should be different from the P2 account suspension case
    expect(r.caseId).not.toBe(firstCaseId);
    expect(r.ticketId).toBeTruthy();
  });

  it('[F10-4] extreme distress → same P1 case, compassionate reply', async () => {
    const r = await chat('I am desperate, our life depends on getting this resolved today, please');
    expect(r.caseId).toBeTruthy();
    expect(r.ticketId).toBeFalsy();
    expect(r.reply.toLowerCase()).toMatch(
      /understand|sorry|urgent|priority|team|working|help/
    );
  });
});