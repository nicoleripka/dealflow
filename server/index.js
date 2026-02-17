require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// ── Database Setup ──────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('render.com') ? { rejectUnauthorized: false } : false
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS companies (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      website TEXT,
      description TEXT,
      stage TEXT DEFAULT 'tracking',
      source TEXT,
      investors TEXT,
      notes TEXT,
      tags TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS people (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT,
      title TEXT,
      linkedin TEXT,
      company_id INTEGER REFERENCES companies(id),
      relationship TEXT DEFAULT 'new',
      source TEXT,
      notes TEXT,
      tags TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS interactions (
      id SERIAL PRIMARY KEY,
      company_id INTEGER REFERENCES companies(id),
      person_id INTEGER REFERENCES people(id),
      type TEXT,
      summary TEXT,
      raw_input TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS intake_log (
      id SERIAL PRIMARY KEY,
      raw_text TEXT NOT NULL,
      parsed_json TEXT,
      source TEXT,
      status TEXT DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('  ✓ Database tables ready');
}

// ── AI Parsing ──────────────────────────────────────────────────────
async function parseWithClaude(rawText) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.log('No ANTHROPIC_API_KEY set — using basic parsing fallback');
    return basicParse(rawText);
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        system: `You are a deal flow parser for a venture capital / investment professional.
Given raw text (forwarded emails, notes, etc.), extract structured data about companies and people mentioned.

Return ONLY valid JSON with this structure:
{
  "companies": [
    {
      "name": "Company Name",
      "description": "Brief description if available",
      "stage": "one of: tracking|meeting_scheduled|considering|passed|invested",
      "source": "where/how they were found",
      "investors": "known investors, comma separated",
      "founders": ["Founder Name 1", "Founder Name 2"]
    }
  ],
  "people": [
    {
      "name": "Person Name",
      "title": "their role if known",
      "company": "associated company if known",
      "relationship": "one of: new|met|in_touch|close"
    }
  ]
}

If you can't determine a field, omit it. Extract as much as you can from messy notes.
Do NOT include any text outside the JSON.`,
        messages: [{ role: 'user', content: rawText }]
      })
    });

    const data = await response.json();
    const text = data.content?.[0]?.text || '';
    const cleaned = text.replace(/```json\n?/g, '').replace(/```/g, '').trim();
    return JSON.parse(cleaned);
  } catch (err) {
    console.error('Claude parse error:', err.message);
    return basicParse(rawText);
  }
}

function basicParse(rawText) {
  const lines = rawText.split('\n').map(l => l.trim()).filter(l => l.length > 1);
  const companies = [];
  const people = [];
  for (const line of lines) {
    if (line.endsWith(':') || line.startsWith('#') || line.startsWith('—')) continue;
    const parts = line.split(/[,\-–—]/);
    if (parts.length >= 2) {
      const first = parts[0].trim();
      const second = parts[1].trim();
      const isName = second.split(' ').length <= 4 && /^[A-Z]/.test(second);
      if (isName) {
        companies.push({ name: first, founders: [second] });
        people.push({ name: second, company: first });
      } else {
        companies.push({ name: first, investors: second });
      }
    } else {
      const words = line.split(' ');
      const looksLikeName = words.length <= 3 && words.every(w => /^[A-Z]/.test(w));
      if (looksLikeName) {
        people.push({ name: line });
      } else {
        companies.push({ name: line });
      }
    }
  }
  return { companies, people };
}

// ── API Routes ──────────────────────────────────────────────────────

app.get('/api/companies', async (req, res) => {
  const { stage, search, sort = 'created_at', order = 'DESC' } = req.query;
  let sql = 'SELECT * FROM companies WHERE 1=1';
  const params = [];
  let i = 1;
  if (stage && stage !== 'all') { sql += ` AND stage = $${i++}`; params.push(stage); }
  if (search) { sql += ` AND (name ILIKE $${i} OR description ILIKE $${i} OR investors ILIKE $${i} OR notes ILIKE $${i})`; params.push(`%${search}%`); i++; }
  const allowedSorts = ['created_at', 'updated_at', 'name', 'stage'];
  const sortCol = allowedSorts.includes(sort) ? sort : 'created_at';
  sql += ` ORDER BY ${sortCol} ${order === 'ASC' ? 'ASC' : 'DESC'}`;
  const { rows } = await pool.query(sql, params);
  res.json(rows);
});

app.get('/api/companies/:id', async (req, res) => {
  const { rows: [row] } = await pool.query('SELECT * FROM companies WHERE id = $1', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const { rows: people } = await pool.query('SELECT * FROM people WHERE company_id = $1', [req.params.id]);
  const { rows: interactions } = await pool.query('SELECT * FROM interactions WHERE company_id = $1 ORDER BY created_at DESC', [req.params.id]);
  res.json({ ...row, people, interactions });
});

app.post('/api/companies', async (req, res) => {
  const { name, website, description, stage, source, investors, notes, tags } = req.body;
  const { rows: [row] } = await pool.query(
    'INSERT INTO companies (name, website, description, stage, source, investors, notes, tags) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
    [name, website, description, stage || 'tracking', source, investors, notes, tags]
  );
  res.json(row);
});

app.put('/api/companies/:id', async (req, res) => {
  const { name, website, description, stage, source, investors, notes, tags } = req.body;
  const { rows: [row] } = await pool.query(
    'UPDATE companies SET name=$1, website=$2, description=$3, stage=$4, source=$5, investors=$6, notes=$7, tags=$8, updated_at=NOW() WHERE id=$9 RETURNING *',
    [name, website, description, stage, source, investors, notes, tags, req.params.id]
  );
  res.json(row);
});

app.delete('/api/companies/:id', async (req, res) => {
  await pool.query('DELETE FROM companies WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

app.get('/api/people', async (req, res) => {
  const { search, relationship } = req.query;
  let sql = 'SELECT p.*, c.name as company_name FROM people p LEFT JOIN companies c ON p.company_id = c.id WHERE 1=1';
  const params = [];
  let i = 1;
  if (relationship && relationship !== 'all') { sql += ` AND p.relationship = $${i++}`; params.push(relationship); }
  if (search) { sql += ` AND (p.name ILIKE $${i} OR p.email ILIKE $${i} OR p.title ILIKE $${i} OR p.notes ILIKE $${i})`; params.push(`%${search}%`); i++; }
  sql += ' ORDER BY p.created_at DESC';
  const { rows } = await pool.query(sql, params);
  res.json(rows);
});

app.post('/api/people', async (req, res) => {
  const { name, email, title, linkedin, company_id, relationship, source, notes, tags } = req.body;
  const { rows: [row] } = await pool.query(
    'INSERT INTO people (name, email, title, linkedin, company_id, relationship, source, notes, tags) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
    [name, email, title, linkedin, company_id, relationship || 'new', source, notes, tags]
  );
  res.json(row);
});

app.put('/api/people/:id', async (req, res) => {
  const { name, email, title, linkedin, company_id, relationship, source, notes, tags } = req.body;
  const { rows: [row] } = await pool.query(
    'UPDATE people SET name=$1, email=$2, title=$3, linkedin=$4, company_id=$5, relationship=$6, source=$7, notes=$8, tags=$9, updated_at=NOW() WHERE id=$10 RETURNING *',
    [name, email, title, linkedin, company_id, relationship, source, notes, tags, req.params.id]
  );
  res.json(row);
});

app.delete('/api/people/:id', async (req, res) => {
  await pool.query('DELETE FROM people WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

app.post('/api/intake', async (req, res) => {
  const { text, source = 'manual' } = req.body;
  if (!text) return res.status(400).json({ error: 'No text provided' });
  const { rows: [log] } = await pool.query('INSERT INTO intake_log (raw_text, source) VALUES ($1, $2) RETURNING id', [text, source]);
  const parsed = await parseWithClaude(text);
  await pool.query('UPDATE intake_log SET parsed_json = $1, status = $2 WHERE id = $3', [JSON.stringify(parsed), 'parsed', log.id]);
  const created = { companies: [], people: [] };
  for (const co of (parsed.companies || [])) {
    const { rows: existing } = await pool.query('SELECT id FROM companies WHERE LOWER(name) = LOWER($1)', [co.name]);
    if (existing.length > 0) { created.companies.push({ ...co, id: existing[0].id, status: 'duplicate' }); continue; }
    const { rows: [newCo] } = await pool.query(
      'INSERT INTO companies (name, description, stage, source, investors) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [co.name, co.description || null, co.stage || 'tracking', co.source || source, co.investors || null]
    );
    created.companies.push({ ...co, id: newCo.id, status: 'created' });
    for (const founder of (co.founders || [])) {
      const { rows: ep } = await pool.query('SELECT id FROM people WHERE LOWER(name) = LOWER($1)', [founder]);
      if (ep.length === 0) {
        await pool.query('INSERT INTO people (name, company_id, relationship, source) VALUES ($1,$2,$3,$4)', [founder, newCo.id, 'new', source]);
      }
    }
  }
  for (const person of (parsed.people || [])) {
    const { rows: existing } = await pool.query('SELECT id FROM people WHERE LOWER(name) = LOWER($1)', [person.name]);
    if (existing.length > 0) { created.people.push({ ...person, id: existing[0].id, status: 'duplicate' }); continue; }
    let companyId = null;
    if (person.company) {
      const { rows: co } = await pool.query('SELECT id FROM companies WHERE LOWER(name) = LOWER($1)', [person.company]);
      if (co.length > 0) companyId = co[0].id;
    }
    const { rows: [np] } = await pool.query(
      'INSERT INTO people (name, title, company_id, relationship, source) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [person.name, person.title || null, companyId, person.relationship || 'new', source]
    );
    created.people.push({ ...person, id: np.id, status: 'created' });
  }
  await pool.query('UPDATE intake_log SET status = $1 WHERE id = $2', ['completed', log.id]);
  res.json({ parsed, created });
});

app.post('/api/intake/email', async (req, res) => {
  const text = req.body.text || req.body['stripped-text'] || req.body.plain || '';
  const subject = req.body.subject || '';
  const from = req.body.from || req.body.sender || '';
  const fullText = `${subject}\n${text}`.trim();
  if (!fullText) return res.status(400).json({ error: 'No content' });
  try {
    const { rows: [log] } = await pool.query('INSERT INTO intake_log (raw_text, source) VALUES ($1, $2) RETURNING id', [fullText, `email:${from}`]);
    const parsed = await parseWithClaude(fullText);
    await pool.query('UPDATE intake_log SET parsed_json = $1, status = $2 WHERE id = $3', [JSON.stringify(parsed), 'parsed', log.id]);
    const created = { companies: [], people: [] };
    for (const co of (parsed.companies || [])) {
      const { rows: existing } = await pool.query('SELECT id FROM companies WHERE LOWER(name) = LOWER($1)', [co.name]);
      if (existing.length === 0) {
        const { rows: [newCo] } = await pool.query(
          'INSERT INTO companies (name, description, stage, source, investors) VALUES ($1,$2,$3,$4,$5) RETURNING id',
          [co.name, co.description || null, co.stage || 'tracking', `email:${from}`, co.investors || null]
        );
        created.companies.push({ ...co, id: newCo.id });
      }
    }
    for (const person of (parsed.people || [])) {
      const { rows: existing } = await pool.query('SELECT id FROM people WHERE LOWER(name) = LOWER($1)', [person.name]);
      if (existing.length === 0) {
        let companyId = null;
        if (person.company) {
          const { rows: co } = await pool.query('SELECT id FROM companies WHERE LOWER(name) = LOWER($1)', [person.company]);
          if (co.length > 0) companyId = co[0].id;
        }
        await pool.query('INSERT INTO people (name, title, company_id, relationship, source) VALUES ($1,$2,$3,$4,$5)',
          [person.name, person.title || null, companyId, person.relationship || 'new', `email:${from}`]);
        created.people.push(person);
      }
    }
    await pool.query('UPDATE intake_log SET status = $1 WHERE id = $2', ['completed', log.id]);
    res.json({ ok: true, created });
  } catch (err) {
    console.error('Email intake error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sync/airtable', async (req, res) => {
  const baseId = process.env.AIRTABLE_BASE_ID;
  const apiKey = process.env.AIRTABLE_API_KEY;
  const tableName = process.env.AIRTABLE_TABLE_NAME || 'Companies';
  if (!baseId || !apiKey) return res.status(400).json({ error: 'Airtable not configured' });
  const { rows: companies } = await pool.query('SELECT * FROM companies ORDER BY created_at DESC');
  const results = [];
  for (const co of companies) {
    try {
      const airtableRes = await fetch(`https://api.airtable.com/v0/${baseId}/${encodeURIComponent(tableName)}`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: { 'Name': co.name, 'Description': co.description || '', 'Stage': co.stage || 'tracking', 'Source': co.source || '', 'Investors': co.investors || '', 'Notes': co.notes || '', 'Added': co.created_at } })
      });
      const data = await airtableRes.json();
      results.push({ company: co.name, status: 'synced', airtable_id: data.id });
    } catch (err) {
      results.push({ company: co.name, status: 'error', error: err.message });
    }
  }
  res.json({ synced: results });
});

app.get('/api/stats', async (req, res) => {
  const [tc, tp, bs, ri, tw] = await Promise.all([
    pool.query('SELECT COUNT(*) as count FROM companies'),
    pool.query('SELECT COUNT(*) as count FROM people'),
    pool.query('SELECT stage, COUNT(*) as count FROM companies GROUP BY stage'),
    pool.query("SELECT COUNT(*) as count FROM intake_log WHERE created_at > NOW() - INTERVAL '7 days'"),
    pool.query("SELECT COUNT(*) as count FROM companies WHERE created_at > NOW() - INTERVAL '7 days'")
  ]);
  res.json({
    totalCompanies: parseInt(tc.rows[0].count),
    totalPeople: parseInt(tp.rows[0].count),
    byStage: bs.rows,
    recentIntakes: parseInt(ri.rows[0].count),
    thisWeek: parseInt(tw.rows[0].count)
  });
});

app.get('/api/intake-log', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM intake_log ORDER BY created_at DESC LIMIT 50');
  res.json(rows);
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
initDb().then(() => {
  app.listen(PORT, () => { console.log(`\n  ⚡ DealFlow running on port ${PORT}\n`); });
}).catch(err => { console.error('DB init failed:', err); process.exit(1); });
