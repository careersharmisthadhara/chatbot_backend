// ── Chatbot service — Anthropic Claude API + keyword retrieval ────────────────
//
// Zero dependency on OpenAI or LangChain.
// Uses @anthropic-ai/sdk for LLM calls.
// Uses a fast in-process keyword scorer as the retrieval layer (no vector DB).
//
// Add to backend/.env:
//   ANTHROPIC_API_KEY=sk-ant-...
//
// Install:  npm install @anthropic-ai/sdk

const OpenAI = require('openai');
const { v4: uuidv4 } = require('uuid');
const fs   = require('fs');
const path = require('path');

// ── Config ────────────────────────────────────────────────────────────────────

const CONFIDENCE_THRESHOLD = parseFloat(process.env.CHATBOT_CONFIDENCE_THRESHOLD || '0.20');
const CONTEXT_WINDOW       = 5;   // prior messages kept in prompt
const TOP_K                = 5;   // documents returned per query
const SESSIONS_FILE        = path.join(__dirname, '../../data/chat-sessions.json');

// ── Anthropic client ──────────────────────────────────────────────────────────

const client = new OpenAI({ apiKey: process.env.GROQ_API_KEY, baseURL: 'https://api.groq.com/openai/v1', });

// ── Synonym map ───────────────────────────────────────────────────────────────
// Maps words users commonly type → words that appear in FAQ/data text.

const SYNONYMS = {
  // Routing / support
  'handles':    ['supports', 'site'],
  'handle':     ['supports', 'site'],
  'support':    ['supports', 'site'],
  'covers':     ['supports', 'site'],
  'responsible':['supports', 'site'],
  'manage':     ['supports', 'site'],
  'who':        ['cfs', 'site'],
  'where':      ['site', 'location'],

  // Services
  'services':   ['service', 'imaging', 'provisioning'],
  'available':  ['regions', 'emea', 'americas', 'ap'],
  'offer':      ['available', 'regions'],
  'offers':     ['available', 'regions'],
  'provide':    ['available', 'service'],
  'use':        ['service', 'available'],

  // Countries / routing
  'country':    ['countrycode', 'geo', 'region'],
  'route':      ['site', 'offshore', 'onshore'],
  'ship':       ['site', 'shipment', 'offshore'],
  'send':       ['site', 'shipment'],
  'deliver':    ['site', 'shipment'],
  'order':      ['site', 'lssc'],

  // SOW
  'contract':   ['sow', 'statement'],
  'agreement':  ['sow', 'statement'],
  'paperwork':  ['sow', 'statement'],
  'need':       ['required', 'requires'],
  'require':    ['required', 'sow'],
  'mandatory':  ['required', 'sow'],

  // On/Offshore
  'offshore':   ['offshore', 'onshore'],
  'onshore':    ['onshore', 'offshore'],
  'local':      ['onshore'],
  'remote':     ['offshore'],

  // Misc
  'number':     ['partnumber', 'part', 'cfs-'],
  'code':       ['countrycode', 'partnumber'],
  'flag':       ['status', 'lssc', 'stopped'],
  'issue':      ['status', 'stopped', 'lssc'],
  'problem':    ['status', 'stopped'],
  'blocked':    ['stopped', 'shipment'],
  'banned':     ['stopped', 'shipment'],
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

// ── Expand query with synonyms ────────────────────────────────────────────────

function expandTokens(tokens) {
  const expanded = new Set(tokens);
  tokens.forEach(t => {
    if (SYNONYMS[t]) SYNONYMS[t].forEach(s => expanded.add(s));
  });
  return [...expanded];
}

// ── Score a document against a query ─────────────────────────────────────────

function score(queryTokens, expandedTokens, docText) {
  let hits = 0;

  // Count expanded token matches (base score)
  expandedTokens.forEach(t => { if (docText.includes(t)) hits += 1; });

  // Bonus: original (unexpanded) token matches count double
  queryTokens.forEach(t => { if (docText.includes(t)) hits += 1; });

  // Bonus: exact consecutive pair matches (bigrams)
  for (let i = 0; i < queryTokens.length - 1; i++) {
    const bigram = queryTokens[i] + ' ' + queryTokens[i + 1];
    if (docText.includes(bigram)) hits += 3;
  }

  // Normalise by expanded token count to keep 0–1 range comparable
  return hits / Math.max(expandedTokens.length + queryTokens.length, 1);
}

// ── In-process document index ─────────────────────────────────────────────────

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
      // Store both question and answer — question wording is especially valuable
      text: [
        f.question,
        f.answer,
        // Also index just the question keywords again for extra weight
        f.question,
      ].join(' ').toLowerCase(),
      meta: { type: 'faq', id: f.id, question: f.question },
    })),
  ];

  console.log(`[Chatbot] Index built — ${docs.length} documents (${docs.filter(d => d.meta.type === 'faq').length} FAQs)`);
}

// ── Retrieve top-k documents ──────────────────────────────────────────────────

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


// ── Core query function ───────────────────────────────────────────────────────

// ── Small talk detector ───────────────────────────────────────────────────────

const GREETINGS = new Set([
  'hi','hello','hey','hiya','howdy','sup','yo','greetings',
  'good morning','good afternoon','good evening','morning','afternoon',
]);

const GREET_REPLIES = [
   'Hi! Ask me about CFS services, country routing, or part numbers.',
  'Hello! How can I help you with CFS today?',
  'Hey! Ask me anything about CFS services or countries.',
  'Got it — feel free to ask me any CFS question.',
  'Sure, go ahead — I\'m here to help with CFS queries.',
  'Of course! What would you like to know about CFS?',
];

const SMALL_TALK = new Set([
  'ok','okay','sure','alright','right','got it','i see','understood',
  'thanks','thank you','cheers','noted','fine','cool','great',
  'no','nope','yes','yeah','yep','nah','hmm','hm','ah','oh',
  'not now','maybe later','never mind','nevermind','skip',
  'just thinking','thinking','just check','let me think',
]);

function isGreeting(msg) {
  const clean = msg.toLowerCase().trim().replace(/[!?.…]+$/, '').trim();
  // Short messages or pure small talk
  if (clean.length < 4) return true;
  if (GREETINGS.has(clean))   return true;
  if (SMALL_TALK.has(clean))  return true;
  // Partial matches — "hey .. w" type noise
  if (clean.split(/\s+/).length <= 2 && clean.replace(/[a-z\s]/g, '').length > 1) return true;
  return false;
}
function randomGreeting() {
  return GREET_REPLIES[Math.floor(Math.random() * GREET_REPLIES.length)];
}

// ── Query ─────────────────────────────────────────────────────────────────────

async function query(userMessage, history = []) {

  // Handle greetings and very short messages directly — no retrieval needed
  if (isGreeting(userMessage)) {
    return {
      shouldEscalate:  false,
      confidenceScore: 1,
      stream:          singleChunk(randomGreeting()),
    };
  }

  const results    = retrieve(userMessage);
  const bestScore  = results.length > 0 ? results[0].score : 0;
  const shouldEscalate = bestScore < CONFIDENCE_THRESHOLD || results.length === 0;

  if (shouldEscalate) {
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

 const systemPrompt = `You are a helpful assistant for Lenovo Custom Fulfilment Services (CFS).
STRICT RULES — follow these without exception:
1. Answer ONLY using the context provided below.
2. If the answer is not in the context, say exactly: "I don't have that information in my knowledge base."
3. NEVER guess, infer, or invent acronyms, part numbers, country mappings, or service details.
4. If the user pushes back or asks you to reconsider, repeat rule 2 — do not change your answer.
5. Do not expand acronyms unless they appear explicitly in the context.

Context:
${context}`;

  return {
    shouldEscalate:  false,
    confidenceScore: bestScore,
    stream:          streamResponse(systemPrompt, historyMessages, userMessage),
  };
}

// Wraps a plain string as an async generator so greetings use the same
// streaming path as LLM responses — no special-casing needed in the handler.
async function* singleChunk(text) {
  console.log("text==============================================",text);
  yield text;
}

async function* streamResponse(system, history, userMessage) {
  const messages = [
    ...history,
    { role: 'user', content: userMessage },
  ];

  const stream = await client.messages.stream({
    model:      'claude-sonnet-4-5',
    max_tokens: 1024,
    system,
    messages,
  });

  for await (const event of stream) {
    if (
      event.type === 'content_block_delta' &&
      event.delta?.type === 'text_delta'
    ) {
      yield event.delta.text;
    }
  }
}

// ── Session persistence ───────────────────────────────────────────────────────

function loadSessions() {
  try { return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')); }
  catch { return []; }
}

function saveSession(session) {
  const sessions = loadSessions();
  const idx = sessions.findIndex(s => s.id === session.id);
  if (idx >= 0) sessions[idx] = session;
  else sessions.push(session);
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2), 'utf8');
}

// ── Init ──────────────────────────────────────────────────────────────────────

async function init(services, countries, faqs) {
  console.log('[Chatbot] Initialising...');
  buildIndex(services, countries, faqs);
  console.log('[Chatbot] Ready — using Anthropic Claude API');
}

// ── Socket.io handlers ────────────────────────────────────────────────────────

// Detects when user is asking to raise a ticket rather than asking a CFS question
function isRaiseTicketRequest(msg) {
  const m = msg.toLowerCase();
  return [
    'raise a ticket', 'create a ticket', 'open a ticket',
    'log a ticket', 'raise ticket', 'create ticket',
    'support ticket', 'could you raise', 'please raise',
    'raise a query', 'submit a ticket', 'could you create',
    'raise the ticket', 'open the ticket', 'create the ticket',
    'raise it', 'go ahead and raise', 'yes raise', 'okay raise',
    'ok raise', 'just raise', 'then raise', 'raise query',
    'log it', 'submit it', 'go ahead',
  ].some(phrase => m.includes(phrase));
}
// Walks back through history to find the last real CFS question
function findLastMeaningfulQuery(history) {
  const userMessages = history
    .filter(m => m.role === 'user')
    .reverse();

  for (const m of userMessages) {
    if (!isRaiseTicketRequest(m.content) && !isGreeting(m.content)) {
      return m.content;
    }
  }
  return null;
}



function registerHandlers(io) {
  io.on('connection', (socket) => {
    const sessionId = uuidv4();
    const history   = [];
    const session   = {
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

    // ── Incoming user message ──
    socket.on('chat:message', async ({ content }) => {
      if (!content?.trim()) return;

      session.messages.push({ role: 'user', content, createdAt: new Date().toISOString() });
      history.push({ role: 'user', content });
      socket.emit('chat:thinking');

      // If user is explicitly asking to raise a ticket, find the real question
      if (isRaiseTicketRequest(content)) {
        const relevantQuery = findLastMeaningfulQuery(history);
        socket.emit('chat:escalate', {
          message:        "Opening the ticket form now with your earlier question pre-filled.",
          sessionId,
          prefilledQuery: relevantQuery || content,
          autoOpen:       true,   // tells frontend to open modal directly
        });
        session.escalated = true;
        saveSession(session);
        return;
      }

      try {
        const result = await query(content, history);

        if (result.shouldEscalate) {
          const botMsg = {
            role: 'assistant', content: result.answer,
            confidenceScore: result.confidenceScore, intentResolved: false,
            createdAt: new Date().toISOString(),
          };
          session.messages.push(botMsg);
          session.escalated = true;
          saveSession(session);

          socket.emit('chat:escalate', {
            message:        result.answer,
            sessionId,
            prefilledQuery: content,
          });
          return;
        }

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
            id: msgId, role: 'assistant', content: fullContent,
            confidenceScore: result.confidenceScore, intentResolved: true,
            createdAt: new Date().toISOString(),
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

    // ── Per-message rating ──
    socket.on('chat:rate', ({ messageId, thumbsUp }) => {
      const msg = session.messages.find(m => m.id === messageId);
      if (msg) { msg.thumbsUp = thumbsUp; saveSession(session); }
    });

    // ── End-of-session rating ──
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
