# CFS Portal — Backend or chatbot_backend

Node.js/Express REST API and real-time chatbot backend for the Lenovo Custom Fulfilment Services (CFS) intranet portal POC.

---

## Tech stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20+ |
| Framework | Express 4 |
| Real-time | Socket.io 4 |
| LLM | Groq API (llama-3.3-70b-versatile) |
| Email | SendGrid SMTP via Nodemailer |
| Data | JSON flat files (no database) |
| Validation | Zod |

---

## Project structure

```
backend/
├── app.js                    # Entry point — Express + Socket.io setup
├── nodemon.json              # Dev server config (ignores data/ writes)
├── package.json
├── .env.example              # Environment variable template
│
├── data/                     # Flat-file data store (no database)
│   ├── services.json         # 20 CFS services
│   ├── countries.json        # 40 countries with CFS site mapping
│   ├── faqs.json             # 30 FAQs across 6 categories
│   ├── chat-sessions.json    # Chatbot session logs (auto-created)
│   ├── feedback.json         # User feedback (auto-created)
│   └── tickets/              # One JSON file per ticket (auto-created)
│       └── CFS-YYYY-NNNNN.json
│
└── src/
    ├── routes/
    │   ├── services.js       # GET /api/services
    │   ├── countries.js      # GET /api/countries
    │   ├── tickets.js        # POST/GET/PATCH /api/tickets
    │   └── analytics.js      # GET /api/analytics/*
    │
    └── services/
        └── chatbot.js        # Groq LLM + keyword retrieval + Socket.io handlers
```

---

## Getting started

### 1. Prerequisites

- Node.js 20 or higher
- A free [Groq API key](https://console.groq.com) (takes 2 minutes)
- A verified [SendGrid sender](https://app.sendgrid.com/settings/sender_auth) for email (optional)

### 2. Install dependencies

```bash
cd backend
npm install
```

### 3. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and fill in your values:

```env
PORT=3001
CLIENT_ORIGIN=http://localhost:5173

# Required — free tier at https://console.groq.com
GROQ_API_KEY=gsk_...

# Optional — ticket emails won't send but tickets still save to disk
SENDGRID_API_KEY=SG....
EMAIL_FROM=yourverifiedemail@gmail.com

# Chatbot confidence threshold (0.0 – 1.0)
CHATBOT_CONFIDENCE_THRESHOLD=0.10
```

### 4. Start the server

```bash
# Development (auto-restart on file changes)
npm run dev

# Production
npm start
```

Server runs at `http://localhost:3001`

---

## API reference

### Services

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/services` | All services. Supports `?category=`, `?region=`, `?sow=` filters |

### Countries

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/countries` | All countries. Supports `?geo=`, `?shore=`, `?search=` filters |

### Tickets

| Method | Endpoint | Description |
|---|---|---|
| POST | `/api/tickets` | Create a new ticket. Returns `{ reference, ticket }` |
| GET | `/api/tickets` | List all tickets |
| GET | `/api/tickets/:ref` | Get a single ticket by reference |
| PATCH | `/api/tickets/:ref` | Update ticket status |

**POST `/api/tickets` — request body:**
```json
{
  "subject":     "Question about CFS imaging for Germany",
  "description": "Which CFS site handles Germany for imaging?",
  "priority":    "NORMAL",
  "category":    "SERVICE_QUERY",
  "submittedBy": "user@lenovo.com",
  "sessionId":   "uuid"
}
```

### Analytics

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/analytics/summary` | Total sessions, tickets, resolution rate |
| GET | `/api/analytics/chatbot` | Session counts, top queries, ratings |
| GET | `/api/analytics/tickets` | Ticket volume by status and category |

---

## Chatbot architecture

The chatbot runs over Socket.io. Every browser tab gets its own socket connection and in-memory session history.

```
User message
    │
    ▼
classifyIntent()          ← Groq llama-3.1-8b-instant (fast, cheap)
    │
    ├── TICKET  → findLastMeaningfulQuery()  ← Groq extracts real question
    │             emit chat:escalate { autoOpen: true }
    │
    ├── CHAT    → getConversationalReply()   ← Groq generates warm reply
    │             emit chat:chunk + chat:done
    │
    └── CFS     → retrieve()                ← Local keyword scorer
                  score < threshold → emit chat:escalate { autoOpen: false }
                  score ≥ threshold → getCFSAnswer() ← Groq streams answer
                                      emit chat:chunk (streaming)
                                      emit chat:done
```

### Socket.io events

**Client → Server:**

| Event | Payload | Description |
|---|---|---|
| `chat:message` | `{ content }` | Send a user message |
| `chat:rate` | `{ messageId, thumbsUp }` | Rate a bot response |
| `chat:end` | `{ rating, feedback }` | End session with optional feedback |
| `chat:ticketCreated` | `{ ticketRef }` | Notify backend of ticket submission |

**Server → Client:**

| Event | Payload | Description |
|---|---|---|
| `chat:session` | `{ sessionId }` | Session UUID on connect |
| `chat:thinking` | — | Bot is processing |
| `chat:chunk` | `{ chunk }` | Streaming text token |
| `chat:done` | `{ messageId, confidenceScore }` | Stream complete |
| `chat:escalate` | `{ message, prefilledQuery, autoOpen }` | Escalation to ticket |
| `chat:error` | `{ message }` | Error response |

---

## Data files

All data is served from JSON files in `data/`. No migrations, no database setup.

| File | Contents |
|---|---|
| `services.json` | 20 CFS services — name, part number, category, regions, SOW requirement |
| `countries.json` | 40 countries — code, GEO, region, CFS site, on/offshore, status flags |
| `faqs.json` | 30 FAQs — question, answer, category |
| `chat-sessions.json` | Auto-written on every conversation |
| `tickets/` | One file per ticket e.g. `CFS-2026-00001.json` |

---

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | No | `3001` | Server port |
| `CLIENT_ORIGIN` | No | `http://localhost:5173` | Frontend URL for CORS |
| `GROQ_API_KEY` | **Yes** | — | Groq API key |
| `SENDGRID_API_KEY` | No | — | SendGrid key for email |
| `EMAIL_FROM` | No | — | Verified sender email |
| `CHATBOT_CONFIDENCE_THRESHOLD` | No | `0.10` | Min retrieval score to answer |

---

## Groq models used

| Purpose | Model | Reason |
|---|---|---|
| Intent classification | `llama-3.1-8b-instant` | Fast, cheap — called on every message |
| CFS answer generation | `llama-3.3-70b-versatile` | Better reasoning for accurate answers |
| Conversational replies | `llama-3.1-8b-instant` | Short replies, speed matters |
| Meaningful query extraction | `llama-3.1-8b-instant` | Simple extraction task |

---

## Nodemon configuration

`nodemon.json` ignores the `data/` directory to prevent server restarts when ticket or session JSON files are written:

```json
{
  "ignore": ["data/*"],
  "ext": "js",
  "watch": ["src/", "app.js"]
}
```

---

## Email setup (SendGrid)

1. Sign up at [sendgrid.com](https://sendgrid.com) — free tier is 100 emails/day
2. Verify a sender at `https://app.sendgrid.com/settings/sender_auth`
3. Create an API key at `https://app.sendgrid.com/settings/api_keys`
4. Add both to `.env` — `SENDGRID_API_KEY` and `EMAIL_FROM` must match the verified sender

Tickets are saved to disk regardless of whether email is configured.

---

## POC cost estimate

Running 20 pilot users for 6 weeks (~300 total messages):

| Item | Cost |
|---|---|
| Groq API (all LLM calls) | ~$0.50 |
| SendGrid (100 emails/day free) | $0.00 |
| **Total** | **~$0.50** |

Groq provides a free tier sufficient for development and small POCs.
