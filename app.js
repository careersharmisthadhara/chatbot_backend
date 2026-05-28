require('dotenv').config();

const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const cors     = require('cors');
const path     = require('path');
const fs       = require('fs');

const chatbot  = require('./src/services/chatbot');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: {
    origin:      process.env.CLIENT_ORIGIN || 'http://localhost:5173',
    credentials: true,
  },
});

app.use(cors({ origin: process.env.CLIENT_ORIGIN || 'http://localhost:5173', credentials: true }));
app.use(express.json());

// Ensure writable data directories exist
const ensureDirs = ['data/tickets'];
ensureDirs.forEach(d => {
  const p = path.join(__dirname, d);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
});

// Ensure writable JSON files exist
const ensureFiles = ['data/chat-sessions.json', 'data/feedback.json'];
ensureFiles.forEach(f => {
  const p = path.join(__dirname, f);
  if (!fs.existsSync(p)) fs.writeFileSync(p, '[]', 'utf8');
});

// Routes
app.use('/api/services',   require('./src/routes/services'));
app.use('/api/countries',  require('./src/routes/countries'));
app.use('/api/tickets',    require('./src/routes/tickets'));
app.use('/api/analytics',  require('./src/routes/analytics'));

app.get('/health', (_, res) => res.json({ status: 'ok', ts: new Date() }));

// Register socket.io chat handlers
chatbot.registerHandlers(io);

const PORT = parseInt(process.env.PORT || '3001', 10);

async function start() {
  const services  = require('./data/services.json');
  const countries = require('./data/countries.json');
  const faqs      = require('./data/faqs.json');

  await chatbot.init(services, countries, faqs);

  server.listen(PORT, () => {
    console.log(`\n[CFS Portal] API running  →  http://localhost:${PORT}`);
    console.log(`[CFS Portal] Socket.io    →  ws://localhost:${PORT}\n`);
  });
}

start().catch(err => {
  console.error('[Startup Error]', err.message);
  process.exit(1);
});
