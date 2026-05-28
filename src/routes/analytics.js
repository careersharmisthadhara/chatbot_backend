const { Router } = require('express');
const fs         = require('fs');
const path       = require('path');

const router        = Router();
const SESSIONS_FILE = path.join(__dirname, '../../data/chat-sessions.json');
const TICKETS_DIR   = path.join(__dirname, '../../data/tickets');

// ── Helpers ───────────────────────────────────────────────────────────────────

function loadSessions() {
  try { return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')); }
  catch { return []; }
}

function loadTickets() {
  if (!fs.existsSync(TICKETS_DIR)) return [];
  return fs.readdirSync(TICKETS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(fs.readFileSync(path.join(TICKETS_DIR, f), 'utf8')));
}

function withinDays(isoDate, days) {
  return new Date(isoDate) >= new Date(Date.now() - days * 86400000);
}

function parseDays(query) {
  const d = parseInt(query.days, 10);
  return (!isNaN(d) && d > 0 && d <= 365) ? d : 30;
}

// ── Chat stats ────────────────────────────────────────────────────────────────

function getChatStats(days) {
  const sessions = loadSessions().filter(s => withinDays(s.startedAt, days));

  const total    = sessions.length;
  const resolved = sessions.filter(s => !s.escalated).length;
  const esc      = total - resolved;

  // All assistant messages across sessions
  const allMessages = sessions.flatMap(s => s.messages || []);
  const botMsgs     = allMessages.filter(m => m.role === 'assistant');
  const rated       = botMsgs.filter(m => m.thumbsUp !== undefined && m.thumbsUp !== null);
  const positive    = rated.filter(m => m.thumbsUp === true).length;

  const satScores = sessions.filter(s => s.satisfactionRating).map(s => s.satisfactionRating);
  const avgSat    = satScores.length
    ? (satScores.reduce((a, b) => a + b, 0) / satScores.length).toFixed(1)
    : null;

  // Daily breakdown (last N days)
  const dailyMap = {};
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    dailyMap[d] = { day: d, sessions: 0, escalations: 0 };
  }
  sessions.forEach(s => {
    const d = s.startedAt.slice(0, 10);
    if (dailyMap[d]) {
      dailyMap[d].sessions++;
      if (s.escalated) dailyMap[d].escalations++;
    }
  });

  // Top user queries
  const userMsgs = allMessages.filter(m => m.role === 'user');
  const freqMap  = {};
  userMsgs.forEach(m => { freqMap[m.content] = (freqMap[m.content] || 0) + 1; });
  const topQueries = Object.entries(freqMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([content, frequency]) => ({ content, frequency }));

  // Satisfaction distribution
  const satDist = [1, 2, 3, 4, 5].map(r => ({
    rating: r,
    count:  satScores.filter(s => s === r).length,
  }));

  return {
    summary: {
      totalSessions:   total,
      resolved,
      escalated:       esc,
      resolutionRate:  total > 0 ? ((resolved / total) * 100).toFixed(1) : '0',
      avgSatisfaction: avgSat,
      thumbsUpRate:    rated.length > 0 ? ((positive / rated.length) * 100).toFixed(1) : null,
    },
    dailyBreakdown:           Object.values(dailyMap),
    satisfactionDistribution: satDist,
    topQueries,
  };
}

// ── Ticket stats ──────────────────────────────────────────────────────────────

function getTicketStats(days) {
  const tickets = loadTickets().filter(t => withinDays(t.createdAt, days));

  const total    = tickets.length;
  const resolved = tickets.filter(t => t.status === 'RESOLVED').length;
  const open     = tickets.filter(t => !['RESOLVED','CLOSED'].includes(t.status)).length;

  const resTimes = tickets
    .filter(t => t.resolvedAt)
    .map(t => (new Date(t.resolvedAt) - new Date(t.createdAt)) / 3600000);
  const avgResHours = resTimes.length
    ? (resTimes.reduce((a, b) => a + b, 0) / resTimes.length).toFixed(1)
    : null;

  // Daily volume
  const dailyMap = {};
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    dailyMap[d] = { day: d, count: 0 };
  }
  tickets.forEach(t => {
    const d = t.createdAt.slice(0, 10);
    if (dailyMap[d]) dailyMap[d].count++;
  });

  // By service area
  const areaMap = {};
  tickets.forEach(t => { areaMap[t.serviceArea] = (areaMap[t.serviceArea] || 0) + 1; });
  const byServiceArea = Object.entries(areaMap)
    .sort((a, b) => b[1] - a[1])
    .map(([serviceArea, count]) => ({ serviceArea, count }));

  // By status (all time)
  const statusMap = {};
  loadTickets().forEach(t => { statusMap[t.status] = (statusMap[t.status] || 0) + 1; });
  const byStatus = Object.entries(statusMap).map(([status, count]) => ({ status, count }));

  return {
    summary: { total, open, resolved, avgResolutionHours: avgResHours },
    dailyVolume:   Object.values(dailyMap),
    byServiceArea,
    byStatus,
  };
}

// ── Routes ────────────────────────────────────────────────────────────────────

router.get('/chatbot', (req, res) => {
  try { res.json(getChatStats(parseDays(req.query))); }
  catch (err) { console.error('[Analytics] chatbot', err); res.status(500).json({ error: err.message }); }
});

router.get('/tickets', (req, res) => {
  try { res.json(getTicketStats(parseDays(req.query))); }
  catch (err) { console.error('[Analytics] tickets', err); res.status(500).json({ error: err.message }); }
});

router.get('/summary', (req, res) => {
  const days = parseDays(req.query);
  try {
    res.json({ chat: getChatStats(days), tickets: getTicketStats(days), days });
  } catch (err) {
    console.error('[Analytics] summary', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
