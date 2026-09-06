const express = require('express');
const path    = require('path');
const { Resend } = require('resend');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const {
  AIRTABLE_TOKEN,
  BASE_ID        = 'appzAoCLDfmTHYuRG',
  SLOTS_TABLE    = 'tblzuvnK7OIM76x5D',
  SIGNUPS_TABLE  = 'tblMa2Ml3y7RH4nIt',
  RESEND_API_KEY,
  SUPERVISOR_EMAIL,
  FROM_EMAIL     = 'clinicals@idahomedicalacademy.com',
} = process.env;

const resend = new Resend(RESEND_API_KEY);

// ── AirTable helpers ──────────────────────────────────────────────────────────

async function atFetch(path, opts = {}) {
  const res = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${AIRTABLE_TOKEN}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `AirTable ${res.status}`);
  }
  return res.json();
}

async function fetchAll(tableId, params = '') {
  let records = [], offset = null;
  do {
    const sep = params ? '&' : '?';
    const url = `${tableId}${params}${offset ? `${sep}offset=${encodeURIComponent(offset)}` : ''}`;
    const data = await atFetch(url);
    records = records.concat(data.records || []);
    offset = data.offset || null;
  } while (offset);
  return records;
}

// ── GET /api/slots ────────────────────────────────────────────────────────────
// Returns available slots with spotsRemaining already computed server-side.

app.get('/api/slots', async (req, res) => {
  try {
    const today  = new Date().toISOString().split('T')[0];
    const filter = encodeURIComponent(`AND({Active}=1,{Slot Date}>='${today}')`);

    const [slotRecords, signupRecords] = await Promise.all([
      fetchAll(SLOTS_TABLE, `?filterByFormula=${filter}&sort[0][field]=Slot+Date&sort[0][direction]=asc`),
      fetchAll(SIGNUPS_TABLE, `?fields[]=Clinical+Slot&fields[]=Status`),
    ]);

    // Count non-declined signups per slot
    const signupCounts = {};
    signupRecords.forEach(r => {
      if (r.fields['Status'] === 'Declined') return;
      (r.fields['Clinical Slot'] || []).forEach(slotId => {
        signupCounts[slotId] = (signupCounts[slotId] || 0) + 1;
      });
    });

    const slots = slotRecords.map(r => {
      const spotsAvailable = r.fields['Spots Available'] || 0;
      const taken          = signupCounts[r.id] || 0;
      return {
        id:             r.id,
        date:           r.fields['Slot Date'],
        site:           r.fields['Site'],
        shiftTime:      r.fields['Shift Time'] || '',
        spotsAvailable,
        spotsRemaining: Math.max(0, spotsAvailable - taken),
        notes:          r.fields['Notes'] || '',
      };
    });

    res.json({ slots });
  } catch (err) {
    console.error('GET /api/slots:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/signup ──────────────────────────────────────────────────────────
// Validates capacity, writes to AirTable, sends both emails via Resend.

app.post('/api/signup', async (req, res) => {
  try {
    const { firstName, lastName, email, slotId, date, site, shiftTime } = req.body;

    if (!firstName || !lastName || !email || !slotId) {
      return res.status(400).json({ error: 'Missing required fields.' });
    }

    // Check if this email already has a confirmed EMT signup
    const [slotRecord, existingSignups, priorSignups] = await Promise.all([
      atFetch(`${SLOTS_TABLE}/${slotId}?fields[]=Spots+Available`),
      fetchAll(SIGNUPS_TABLE, `?filterByFormula=${encodeURIComponent(`AND({Clinical Slot}="${slotId}",{Status}!="Declined")`)}&fields[]=Status`),
      fetchAll(SIGNUPS_TABLE, `?filterByFormula=${encodeURIComponent(`AND({Email}="${email}",{Status}!="Declined")`)}&fields[]=Email&maxRecords=1`),
    ]);

    if (priorSignups.length > 0) {
      return res.status(409).json({ error: 'This email address is already registered for a clinical shift. EMT students may only sign up for one shift.' });
    }

    const spotsAvailable = slotRecord.fields['Spots Available'] || 0;
    if (existingSignups.length >= spotsAvailable) {
      return res.status(409).json({ error: 'This slot is now full. Please choose another date.' });
    }

    // Write signup to AirTable
    await atFetch(SIGNUPS_TABLE, {
      method: 'POST',
      body: JSON.stringify({
        fields: {
          'First Name':     firstName,
          'Last Name':      lastName,
          'Email':          email,
          'Clinical Slot':  [slotId],
          'Clinical Date':  date,
          'Shift Time':     shiftTime || '',
          'Status':         'Confirmed',
        },
      }),
    });

    const formattedDate = fmtDate(date);
    const studentName   = `${firstName} ${lastName}`;
    const timeDisplay   = shiftTime ? ` · ${shiftTime}` : '';

    // Send emails — don't let email failure block the success response
    const emailJobs = [];
    if (SUPERVISOR_EMAIL) {
      emailJobs.push(
        resend.emails.send({
          from:    FROM_EMAIL,
          to:      SUPERVISOR_EMAIL,
          subject: `New EMT Clinical Signup — ${studentName} — ${formattedDate}${timeDisplay}`,
          html:    supervisorEmail(studentName, email, formattedDate, shiftTime, site),
        })
      );
    }
    emailJobs.push(
      resend.emails.send({
        from:    FROM_EMAIL,
        to:      email,
        subject: `Clinical Shift Confirmed — ${formattedDate}${timeDisplay} at ${site}`,
        html:    studentEmail(firstName, formattedDate, shiftTime, site),
      })
    );
    const results = await Promise.allSettled(emailJobs);
    results.forEach((r, i) => {
      if (r.status === 'rejected') console.error(`Email ${i} failed:`, r.reason);
    });

    res.json({ success: true });
  } catch (err) {
    console.error('POST /api/signup:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Catch-all → SPA
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`IMA Clinicals running on port ${PORT}`));

// ── Date helper ───────────────────────────────────────────────────────────────

function fmtDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });
}

// ── Email templates ───────────────────────────────────────────────────────────

function supervisorEmail(name, email, date, shiftTime, site) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"/></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f4f5f7;margin:0;padding:20px;">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">
  <div style="background:#CA0D0C;padding:20px 24px;color:#fff;">
    <div style="font-size:20px;font-weight:800;">IMA Clinical Scheduling</div>
    <div style="font-size:12px;opacity:0.85;margin-top:2px;text-transform:uppercase;letter-spacing:0.05em;">New Student Signup — Confirmed</div>
  </div>
  <div style="padding:24px;">
    <p style="font-size:15px;color:#1a1a2e;margin:0 0 20px;line-height:1.5;">A student has signed up for a clinical shift. Their spot is confirmed. Contact them if you have any questions or need to make changes.</p>
    <table style="width:100%;border-collapse:collapse;font-size:14px;">
      <tr style="border-bottom:1px solid #e5e7eb;">
        <td style="padding:10px 0;color:#6b7280;font-weight:600;width:130px;">Student</td>
        <td style="padding:10px 0;color:#1a1a2e;font-weight:700;">${name}</td>
      </tr>
      <tr style="border-bottom:1px solid #e5e7eb;">
        <td style="padding:10px 0;color:#6b7280;font-weight:600;">Email</td>
        <td style="padding:10px 0;"><a href="mailto:${email}" style="color:#CA0D0C;">${email}</a></td>
      </tr>
      <tr style="border-bottom:1px solid #e5e7eb;">
        <td style="padding:10px 0;color:#6b7280;font-weight:600;">Date</td>
        <td style="padding:10px 0;color:#1a1a2e;font-weight:700;">${date}</td>
      </tr>
      ${shiftTime ? `<tr style="border-bottom:1px solid #e5e7eb;">
        <td style="padding:10px 0;color:#6b7280;font-weight:600;">Shift Time</td>
        <td style="padding:10px 0;color:#1a1a2e;font-weight:700;">${shiftTime}</td>
      </tr>` : ''}
      <tr>
        <td style="padding:10px 0;color:#6b7280;font-weight:600;">Site</td>
        <td style="padding:10px 0;color:#1a1a2e;font-weight:700;">${site}</td>
      </tr>
    </table>
    <div style="margin-top:24px;">
      <a href="https://airtable.com/appzAoCLDfmTHYuRG/tblMa2Ml3y7RH4nIt"
         style="display:inline-block;background:#CA0D0C;color:#fff;padding:11px 22px;border-radius:7px;text-decoration:none;font-weight:700;font-size:14px;">
        View in AirTable →
      </a>
    </div>
  </div>
  <div style="padding:16px 24px;border-top:1px solid #e5e7eb;font-size:12px;color:#6b7280;">
    Idaho Medical Academy — Clinical Supervisor Notifications
  </div>
</div>
</body></html>`;
}

function studentEmail(firstName, date, shiftTime, site) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"/></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f4f5f7;margin:0;padding:20px;">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">
  <div style="background:#CA0D0C;padding:20px 24px;color:#fff;">
    <div style="font-size:20px;font-weight:800;">Idaho Medical Academy</div>
    <div style="font-size:12px;opacity:0.85;margin-top:2px;text-transform:uppercase;letter-spacing:0.05em;">Clinical Shift Confirmed</div>
  </div>
  <div style="padding:24px;">
    <p style="font-size:16px;color:#1a1a2e;margin:0 0 16px;font-weight:700;">Hi ${firstName},</p>
    <p style="font-size:14px;color:#4b5563;margin:0 0 20px;line-height:1.6;">Your EMT clinical shift has been confirmed. Here are your details:</p>
    <div style="background:#f9fafb;border-radius:8px;padding:16px 20px;margin-bottom:20px;border-left:4px solid #CA0D0C;">
      <div style="font-size:13px;color:#6b7280;text-transform:uppercase;letter-spacing:0.06em;font-weight:700;margin-bottom:10px;">Confirmed Shift</div>
      <div style="font-size:16px;color:#1a1a2e;font-weight:700;margin-bottom:4px;">${date}</div>
      ${shiftTime ? `<div style="font-size:14px;color:#1a1a2e;font-weight:600;margin-bottom:4px;">🕐 ${shiftTime}</div>` : ''}
      <div style="font-size:14px;color:#4b5563;">📍 ${site}</div>
    </div>
    <p style="font-size:14px;color:#4b5563;margin:0 0 16px;line-height:1.6;">
      The IMA clinical director has been notified and will reach out if they have any questions.
    </p>
    <p style="font-size:14px;color:#4b5563;margin:0;line-height:1.6;">
      Questions? Email us at
      <a href="mailto:clinicals@idahomedicalacademy.com" style="color:#CA0D0C;">clinicals@idahomedicalacademy.com</a>
    </p>
  </div>
  <div style="padding:16px 24px;border-top:1px solid #e5e7eb;font-size:12px;color:#6b7280;">
    Idaho Medical Academy · EMT Program ·
    <a href="https://idahomedicalacademy.com" style="color:#CA0D0C;">idahomedicalacademy.com</a>
  </div>
</div>
</body></html>`;
}
