const { Router }  = require('express');
const { z }       = require('zod');
const nodemailer  = require('nodemailer');
const fs          = require('fs');
const path        = require('path');

const router      = Router();
const TICKETS_DIR = path.join(__dirname, '../../data/tickets');

// ── Email transport ───────────────────────────────────────────────────────────

const transporter = nodemailer.createTransport({
  host:   process.env.SMTP_HOST || 'smtp.sendgrid.net',
  port:   587,
  secure: false,
  auth:   { user: 'apikey', pass: process.env.SENDGRID_API_KEY },
});

// ── Helpers ───────────────────────────────────────────────────────────────────

let counter = 1;

function initCounter() {
  if (!fs.existsSync(TICKETS_DIR)) fs.mkdirSync(TICKETS_DIR, { recursive: true });
  const files = fs.readdirSync(TICKETS_DIR).filter(f => f.endsWith('.json'));
  if (files.length === 0) { counter = 1; return; }
  const refs = files.map(f => {
    const match = f.match(/CFS-\d{4}-(\d+)/);
    return match ? parseInt(match[1], 10) : 0;
  });
  counter = Math.max(...refs) + 1;
}

initCounter();

function generateRef() {
  const year = new Date().getFullYear();
  const n    = String(counter++).padStart(5, '0');
  return `CFS-${year}-${n}`;
}

function readTicket(ref) {
  const p = path.join(TICKETS_DIR, `${ref}.json`);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeTicket(ticket) {
  const p = path.join(TICKETS_DIR, `${ticket.reference}.json`);
  fs.writeFileSync(p, JSON.stringify(ticket, null, 2), 'utf8');
}

function listTickets({ status, serviceArea, limit = 50, offset = 0 } = {}) {
  const files = fs.readdirSync(TICKETS_DIR)
    .filter(f => f.endsWith('.json'))
    .sort()
    .reverse();

  let tickets = files.map(f => JSON.parse(fs.readFileSync(path.join(TICKETS_DIR, f), 'utf8')));
  if (status)      tickets = tickets.filter(t => t.status === status);
  if (serviceArea) tickets = tickets.filter(t => t.serviceArea === serviceArea);

  return tickets.slice(offset, offset + limit);
}

async function sendConfirmationEmail(ticket) {
  if (!process.env.SENDGRID_API_KEY) {
    console.warn('[Email] SENDGRID_API_KEY not set — skipping confirmation email');
    return;
  }

  await transporter.sendMail({
    from:    `"CFS Support" <${process.env.EMAIL_FROM || 'career.sharmistha.dhara@gmail.com'}>`,
    to:      ticket.requesterEmail,
    subject: `[${ticket.reference}] Your CFS query has been received`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;color:#1A1A1A">
        <div style="background:#E2231A;padding:16px 24px">
          <h1 style="color:white;font-size:18px;margin:0">Lenovo CFS Support Portal</h1>
        </div>
        <div style="padding:24px">
          <h2 style="font-size:16px;font-weight:600;margin-bottom:4px">Query received — ${ticket.reference}</h2>
          <p style="color:#767676;margin-bottom:20px">Hi ${ticket.requesterName}, your query has been logged. A CFS specialist will respond within <strong>48 hours</strong>.</p>
          <table style="width:100%;border-collapse:collapse;font-size:14px">
            <tr style="background:#F5F5F5"><td style="padding:8px 12px;font-weight:600">Reference</td><td style="padding:8px 12px">${ticket.reference}</td></tr>
            <tr><td style="padding:8px 12px;font-weight:600">Subject</td><td style="padding:8px 12px">${ticket.subject}</td></tr>
            <tr style="background:#F5F5F5"><td style="padding:8px 12px;font-weight:600">Service area</td><td style="padding:8px 12px">${ticket.serviceArea}</td></tr>
            <tr><td style="padding:8px 12px;font-weight:600">Priority</td><td style="padding:8px 12px">${ticket.priority}</td></tr>
          </table>
        </div>
        <div style="padding:16px 24px;background:#F5F5F5;font-size:12px;color:#767676">
          Lenovo Custom Fulfilment Services · CFS Support Portal
        </div>
      </div>
    `,
  });
}

// ── Schema ────────────────────────────────────────────────────────────────────

const CreateTicketSchema = z.object({
  subject:              z.string().min(3).max(200),
  description:          z.string().min(10),
  serviceArea:          z.string(),
  geography:            z.string().optional(),
  countryRegion:        z.string().optional(),
  requesterName:        z.string().min(2),
  requesterEmail:       z.string().email(),
  priority:             z.enum(['LOW','MEDIUM','HIGH','CRITICAL']).default('MEDIUM'),
  escalatedFromSession: z.string().optional(),
  prefilledQuery:       z.string().optional(),
});

// ── Routes ────────────────────────────────────────────────────────────────────

// POST /api/tickets
router.post('/', (req, res) => {
  const parsed = CreateTicketSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Validation failed', issues: parsed.error.issues });
  }

  const data      = parsed.data;
  const reference = generateRef();
  const now       = new Date().toISOString();

  const ticket = {
    reference,
    subject:              data.subject,
    description:          data.description,
    serviceArea:          data.serviceArea,
    geography:            data.geography            || null,
    countryRegion:        data.countryRegion        || null,
    requesterName:        data.requesterName,
    requesterEmail:       data.requesterEmail,
    priority:             data.priority,
    status:               'NEW',
    escalatedFromSession: data.escalatedFromSession || null,
    prefilledQuery:       data.prefilledQuery       || null,
    createdAt:            now,
    updatedAt:            now,
    resolvedAt:           null,
  };

  writeTicket(ticket);

  sendConfirmationEmail(ticket).catch(err =>
    console.error('[Email] Confirmation failed:', err.message)
  );

  res.status(201).json(ticket);
});

// GET /api/tickets
router.get('/', (req, res) => {
  const { status, serviceArea, limit, offset } = req.query;
  const tickets = listTickets({
    status,
    serviceArea,
    limit:  limit  ? parseInt(limit, 10)  : 50,
    offset: offset ? parseInt(offset, 10) : 0,
  });
  res.json(tickets);
});

// GET /api/tickets/:reference
router.get('/:reference', (req, res) => {
  const ticket = readTicket(req.params.reference);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  res.json(ticket);
});

// PATCH /api/tickets/:reference/status
router.patch('/:reference/status', (req, res) => {
  const valid  = ['NEW','ASSIGNED','IN_PROGRESS','PENDING_USER_INPUT','RESOLVED','CLOSED'];
  const { status } = req.body;

  if (!valid.includes(status)) {
    return res.status(400).json({ error: `Invalid status. Must be: ${valid.join(', ')}` });
  }

  const ticket = readTicket(req.params.reference);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

  ticket.status    = status;
  ticket.updatedAt = new Date().toISOString();
  if (status === 'RESOLVED') ticket.resolvedAt = ticket.updatedAt;

  writeTicket(ticket);
  res.json(ticket);
});

module.exports = router;
