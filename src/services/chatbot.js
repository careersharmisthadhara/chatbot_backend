// ── Chatbot service — Groq API ────────────────────────────────────────────────
//
// Groq handles ALL language understanding:
//   - Intent classification (TICKET / CFS / CHAT)
//   - Conversational replies
//   - Finding the meaningful query for ticket pre-fill
//
// Local code only handles:
//   - Document retrieval (keyword scorer over JSON files)
//   - Session state (lastBotOfferedTicket, ticketJustOpened flags)
//
// Setup:
//   1. Get free API key at https://console.groq.com
//   2. Add to backend/.env:  GROQ_API_KEY=gsk_...
//   3. npm install openai

const OpenAI         = require('openai');
const { v4: uuidv4 } = require('uuid');
const fs             = require('fs');
const path           = require('path');

// ── Groq client ───────────────────────────────────────────────────────────────

const client = new OpenAI({
  apiKey:  process.env.GROQ_API_KEY,
  baseURL: 'https://api.groq.com/openai/v1',
});

const MODEL      = 'llama-3.3-70b-versatile';
const MODEL_FAST = 'llama-3.1-8b-instant';

// ── Config ────────────────────────────────────────────────────────────────────

const CONFIDENCE_THRESHOLD = parseFloat(process.env.CHATBOT_CONFIDENCE_THRESHOLD || '0.10');
const CONTEXT_WINDOW       = 5;
const SESSIONS_FILE        = path.join(__dirname, '../../data/chat-sessions.json');

// ── Synonym map ───────────────────────────────────────────────────────────────

const SYNONYMS = {
  'handles':    ['supports', 'site'],
  'handle':     ['supports', 'site'],
  'support':    ['supports', 'site'],
  'covers':     ['supports', 'site'],
  'manage':     ['supports', 'site'],
  'who':        ['cfs', 'site'],
  'where':      ['site', 'location'],
  'services':   ['service', 'imaging', 'provisioning'],
  'available':  ['regions', 'emea', 'americas', 'ap'],
  'offer':      ['available', 'regions'],
  'provide':    ['available', 'service'],
  'country':    ['countrycode', 'geo', 'region'],
  'route':      ['site', 'offshore', 'onshore'],
  'ship':       ['site', 'shipment', 'offshore'],
  'send':       ['site', 'shipment'],
  'contract':   ['sow', 'statement'],
  'agreement':  ['sow', 'statement'],
  'need':       ['required', 'requires'],
  'require':    ['required', 'sow'],
  'number':     ['partnumber', 'part', 'cfs-'],
  'code':       ['countrycode', 'partnumber'],
  'flag':       ['status', 'lssc', 'stopped'],
  'blocked':    ['stopped', 'shipment'],
};

// ── Stopwords ─────────────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  'a','an','the','is','are','was','were','be','been','being',
  'do','does','did','have','has','had','will','would','can',
  'could','should','may','might','shall','must','to','of',
  'in','on','at','for','with','by','from','about','as','or',
  'and','but','if','then','that','this','it','its','i','you',
  'we','they','what','which','how','when','where','why','me',
  'my','our','your','their','get','got','give','tell','know',
  'want','need','let','just','also','very','too','so','please',
]);

// ── Tokeniser ─────────────────────────────────────────────────────────────────

function tokenise(text) {
  return text
    .toLowerCase()
    .split(/[\s,.\-?!;:()/'"]+/)
    .filter(w => w.length > 1 && !STOPWORDS.has(w));
}

function expandTokens(tokens) {
  const expanded = new Set(tokens);
  tokens.forEach(t => {
    if (SYNONYMS[t]) SYNONYMS[t].forEach(s => expanded.add(s));
  });
  return [...expanded];
}

// ── Document scorer ───────────────────────────────────────────────────────────

function score(queryTokens, expandedTokens, docText) {
  let hits = 0;
  expandedTokens.forEach(t => { if (docText.includes(t)) hits += 1; });
  queryTokens.forEach(t    => { if (docText.includes(t)) hits += 1; });
  for (let i = 0; i < queryTokens.length - 1; i++) {
    if (docText.includes(queryTokens[i] + ' ' + queryTokens[i + 1])) hits += 3;
  }
  return hits / Math.max(expandedTokens.length + queryTokens.length, 1);
}

// ── Document index ────────────────────────────────────────────────────────────

let docs = [];

function buildIndex(services, countries, faqs) {
  docs = [
    ...services.map(s => ({
      text: [
        `service name ${s.name}`,
        `part number ${s.partNumber || s.id}`,
        `category ${s.category}`,
        `description ${s.description}`,
        `available regions ${(s.regions || []).join(' ')}`,
        `sow required ${s.sowRequired ? 'yes sow required' : 'no sow not required'}`,
      ].join(' ').toLowerCase(),
      meta: { type: 'service', id: s.partNumber || s.id, name: s.name },
    })),

    ...countries.map(c => ({
      text: [
        `country ${c.country}`,
        `country code ${c.countryCode || c.code}`,
        `geo ${c.geo}`,
        `region ${c.region}`,
        `cfs site ${c.cfsSite || c.site}`,
        `site code ${c.cfsSiteCode || c.siteCode || c.sc}`,
        `${(c.onOffshore || c.shore || '').toLowerCase()} designation`,
        c.status ? `status ${c.status} flag` : 'active no flag',
      ].join(' ').toLowerCase(),
      meta: { type: 'country', code: c.countryCode || c.code, name: c.country },
    })),

    ...faqs.map(f => ({
      text: [f.question, f.answer, f.question].join(' ').toLowerCase(),
      meta: { type: 'faq', id: f.id, question: f.question },
    })),
  ];

  console.log(`[Chatbot] Index built — ${docs.length} documents (${docs.filter(d => d.meta.type === 'faq').length} FAQs)`);
}

function retrieve(query) {
  const qTokens  = tokenise(query);
  const exTokens = expandTokens(qTokens);
  if (!qTokens.length) return [];
  return docs
    .map(d => ({ ...d, score: score(qTokens, exTokens, d.text) }))
    .filter(d => d.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

// ── Intent classifier ─────────────────────────────────────────────────────────

async function classifyIntent(msg, history, lastBotOfferedTicket) {
  const recentHistory = history.slice(-6)
    .map(m => `${m.role === 'user' ? 'User' : 'Bot'}: ${m.content}`)
    .join('\n');

  const timeoutPromise = new Promise(resolve =>
    setTimeout(() => resolve('chat'), 4000)
  );

  const classifyPromise = client.chat.completions.create({
    model:       MODEL_FAST,
    max_tokens:  10,
    temperature: 0,
    messages: [
      {
        role:    'system',
        content: `You are an intent classifier for a CFS support chatbot.
Classify the user's latest message into exactly one of these intents:
- TICKET: user wants to raise, create, submit, or open a support ticket or query
- CFS: user is asking ANY factual question — including unknown acronyms, terms, services, countries, processes. If in doubt between CFS and CHAT, choose CFS.
- CHAT: ONLY clear conversational messages with no question — greetings, acknowledgements (okay/sure/great/got it), closing remarks (thanks/done/no thank you/bye), frustration, or pure small talk with zero factual question intent

Important rules:
- Any message with a question word (what, which, where, how, does, is, can, will, when, why) = CFS always
- "what is X" = CFS always, even if X is unknown
- "which site supports X" = CFS always
- If the previous bot message offered to raise a ticket AND the user replied with yes/confirmation/go ahead = TICKET
- Questions about the bot itself (why did you say, what did you mean, you just said) = CHAT
- Short garbled text with no question word = CHAT

Reply with exactly one word: TICKET, CFS, or CHAT.`,
      },
      {
        role:    'user',
        content: `Recent conversation:\n${recentHistory}\n\nUser's latest message: "${msg}"\n\nBot just offered to raise a ticket: ${lastBotOfferedTicket ? 'YES' : 'NO'}\n\nClassify:`,
      },
    ],
  }).then(r => {
    const a = r.choices[0]?.message?.content?.trim().toUpperCase();
    if (a === 'TICKET') return 'ticket';
    if (a === 'CFS')    return 'cfs';
    return 'chat';
  }).catch(() => 'chat');

  return Promise.race([classifyPromise, timeoutPromise]);
}

// ── Conversational reply ──────────────────────────────────────────────────────

async function getConversationalReply(msg) {
  try {
    const response = await client.chat.completions.create({
      model:       MODEL_FAST,
      max_tokens:  80,
      temperature: 0.7,
      messages: [
        {
          role:    'system',
          content: `You are a friendly assistant for Lenovo Custom Fulfilment Services (CFS).
Reply naturally in 1 short sentence based only on the user's current message.
- Greeting (hi/hello/good morning/gm) → greet warmly and invite a CFS question
- Closing (thanks/done/no thank you/bye/all good) → wish them well
- Acknowledgement (okay/sure/great/got it/noted) → acknowledge and invite next question
- Frustration → empathise briefly and offer to raise a ticket or try another question
- NEVER reference previous messages or say "you asked this before"
- NEVER make up CFS facts`,
        },
        {
          role:    'user',
          content: msg,
        },
      ],
    });
    return response.choices[0]?.message?.content?.trim() ||
           'How can I help you with CFS today?';
  } catch {
    return 'How can I help you with CFS today?';
  }
}

// ── Find meaningful query — Groq reads the full history ───────────────────────

async function findLastMeaningfulQuery(history) {
  const userMessages = history
    .filter(m => m.role === 'user')
    .map(m => m.content)
    .join('\n');

  if (!userMessages.trim()) return null;

  const timeoutPromise = new Promise(resolve =>
    setTimeout(() => resolve(null), 4000)
  );

  const queryPromise = client.chat.completions.create({
    model:       MODEL_FAST,
    max_tokens:  80,
    temperature: 0,
    messages: [
      {
        role:    'system',
        content: `You extract the core CFS support question from a list of user messages.
Return ONLY the original factual question the user was trying to get answered.
Rules:
- Return the actual CFS question (about services, countries, part numbers, SOW, processes, availability)
- Ignore meta messages like "how can you help me", "think it through", "raise a ticket", "then how could you help"
- Ignore greetings, acknowledgements, closing messages, and expressions of frustration
- If no clear CFS question exists, return exactly: NONE
- Return the question exactly as the user typed it — no modifications or rewording`,
      },
      {
        role:    'user',
        content: `User messages from this conversation:\n${userMessages}\n\nWhat was the core CFS question the user was asking about?`,
      },
    ],
  }).then(r => {
    const result = r.choices[0]?.message?.content?.trim();
    return (result && result !== 'NONE') ? result : null;
  }).catch(() => null);

  return Promise.race([queryPromise, timeoutPromise]);
}

// ── CFS answer — retrieval + LLM ─────────────────────────────────────────────

async function getCFSAnswer(userMessage, history) {
  const results   = retrieve(userMessage);
  const bestScore = results.length > 0 ? results[0].score : 0;

  if (bestScore < CONFIDENCE_THRESHOLD || results.length === 0) {
    return {
      shouldEscalate:  true,
      confidenceScore: bestScore,
      answer: "I don't have enough information to answer that confidently. Would you like me to raise a support ticket so a CFS specialist can help?",
    };
  }

  const context = results.map(r => r.text).join('\n\n');

  const historyMessages = history.slice(-CONTEXT_WINDOW).map(m => ({
    role:    m.role === 'user' ? 'user' : 'assistant',
    content: m.content,
  }));

  const system = `You are a helpful assistant for Lenovo Custom Fulfilment Services (CFS).
STRICT RULES — no exceptions:
1. Answer ONLY using the context provided below. The context is your entire knowledge.
2. If the term, acronym, or topic does not appear in the context — respond with exactly: "I don't have that information in my knowledge base."
3. NEVER use your own training data to answer. NEVER define acronyms, terms, or services from memory.
4. If the user pushes back or asks you to think harder — repeat rule 2. Do not change your answer.
5. Do not expand or define ANY acronym unless it appears word-for-word in the context.
6. Answer directly — no commentary, no "as I mentioned", no "you asked this before".
7. If the context does not mention the topic at all, you have no information about it. Say so.

Context:
${context}`;

  return {
    shouldEscalate:  false,
    confidenceScore: bestScore,
    stream:          streamResponse(system, historyMessages, userMessage),
  };
}

async function* streamResponse(system, history, userMessage) {
  const stream = await client.chat.completions.create({
    model:    MODEL,
    messages: [
      { role: 'system', content: system },
      ...history,
      { role: 'user',   content: userMessage },
    ],
    stream: true,
  });

  for await (const chunk of stream) {
    const text = chunk.choices[0]?.delta?.content;
    if (text) yield text;
  }
}

// ── Session helpers ───────────────────────────────────────────────────────────

function loadSessions() {
  try { return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')); }
  catch { return []; }
}

function saveSession(session) {
  const sessions = loadSessions();
  const idx      = sessions.findIndex(s => s.id === session.id);
  if (idx >= 0) sessions[idx] = session;
  else sessions.push(session);
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2), 'utf8');
}

// ── Emit plain text response ──────────────────────────────────────────────────

function emitPlain(socket, session, history, text) {
  const msgId = uuidv4();
  socket.emit('chat:chunk', { chunk: text });
  socket.emit('chat:done',  { messageId: msgId, confidenceScore: 1 });
  session.messages.push({ role: 'assistant', content: text, createdAt: new Date().toISOString() });
  history.push({ role: 'assistant', content: text });
  saveSession(session);
}

// ── Init ──────────────────────────────────────────────────────────────────────

async function init(services, countries, faqs) {
  console.log('[Chatbot] Initialising...');
  buildIndex(services, countries, faqs);
  console.log('[Chatbot] Ready — using Groq API (free tier)');
}

// ── Socket.io handlers ────────────────────────────────────────────────────────

function registerHandlers(io) {
  io.on('connection', (socket) => {
    const sessionId = uuidv4();
    const history   = [];
    let lastBotOfferedTicket = false;
    let ticketJustOpened     = false;

    const session = {
      id:                 sessionId,
      userEmail:          socket.handshake.auth?.email || null,
      messages:           [],
      escalated:          false,
      escalatedTicketRef: null,
      satisfactionRating: null,
      freeTextFeedback:   null,
      startedAt:          new Date().toISOString(),
      endedAt:            null,
    };

    saveSession(session);
    socket.emit('chat:session', { sessionId });

    socket.on('chat:message', async ({ content }) => {
      if (!content?.trim()) return;

      session.messages.push({ role: 'user', content, createdAt: new Date().toISOString() });
      history.push({ role: 'user', content });
      socket.emit('chat:thinking');

      try {

        // ── Guard: ticket was just opened ─────────────────────────────────────
        if (ticketJustOpened) {
          ticketJustOpened     = false;
          lastBotOfferedTicket = false;
          emitPlain(socket, session, history,
            'Your ticket form is open — fill in your details and submit.'
          );
          return;
        }

        // ── Let Groq classify the intent ──────────────────────────────────────
        const intent = await classifyIntent(content, history, lastBotOfferedTicket);

        // ── TICKET ────────────────────────────────────────────────────────────
        if (intent === 'ticket') {
          const relevantQuery = await findLastMeaningfulQuery(history);
          socket.emit('chat:escalate', {
            message:        "I've opened the ticket form with your question pre-filled. Fill in your details and submit.",
            sessionId,
            prefilledQuery: relevantQuery || content,
            autoOpen:       true,
          });
          session.escalated    = true;
          lastBotOfferedTicket = false;
          ticketJustOpened     = true;
          setTimeout(() => { ticketJustOpened = false; }, 10000);
          saveSession(session);
          return;
        }

        // ── CHAT ──────────────────────────────────────────────────────────────
        if (intent === 'chat') {
          const text = await getConversationalReply(content);
          emitPlain(socket, session, history, text);
          lastBotOfferedTicket = false;
          return;
        }

        // ── CFS — retrieval + LLM ─────────────────────────────────────────────
        const result = await getCFSAnswer(content, history);

        if (result.shouldEscalate) {
          session.escalated    = true;
          lastBotOfferedTicket = true;
          saveSession(session);
          socket.emit('chat:escalate', {
            message:        result.answer,
            sessionId,
            prefilledQuery: content,
            autoOpen:       false,
          });
          return;
        }

        lastBotOfferedTicket = false;

        let fullContent = '';
        const msgId     = uuidv4();

        try {
          for await (const chunk of result.stream) {
            if (!chunk) continue;
            fullContent += chunk;
            socket.emit('chat:chunk', { chunk });
          }
        } catch (streamErr) {
          console.error('[Chatbot] Stream error:', streamErr.message);
          if (!fullContent) fullContent = 'Sorry, I encountered an error. Please try again.';
        } finally {
          const botMsg = {
            id:             msgId,
            role:           'assistant',
            content:        fullContent,
            confidenceScore: result.confidenceScore,
            intentResolved: true,
            createdAt:      new Date().toISOString(),
          };
          session.messages.push(botMsg);
          history.push({ role: 'assistant', content: fullContent });
          saveSession(session);
          socket.emit('chat:done', { messageId: msgId, confidenceScore: result.confidenceScore });
        }

      } catch (err) {
        console.error('[Chatbot] Error:', err.message);
        socket.emit('chat:error', { message: 'Something went wrong. Please try again.' });
      }
    });

    socket.on('chat:rate', ({ messageId, thumbsUp }) => {
      const msg = session.messages.find(m => m.id === messageId);
      if (msg) { msg.thumbsUp = thumbsUp; saveSession(session); }
    });

    socket.on('chat:end', ({ rating, feedback } = {}) => {
      session.satisfactionRating = rating   || null;
      session.freeTextFeedback   = feedback || null;
      session.endedAt            = new Date().toISOString();
      saveSession(session);
    });

    socket.on('chat:ticketCreated', ({ ticketRef }) => {
      session.escalatedTicketRef = ticketRef;
      saveSession(session);
    });

    socket.on('disconnect', () => {
      if (!session.endedAt) {
        session.endedAt = new Date().toISOString();
        saveSession(session);
      }
    });
  });
}

module.exports = { init, registerHandlers };