// api/dashboard-data.js
// Read-only endpoint for the Luna Trends dashboard. Runs server-side on Vercel,
// holds AIRTABLE_KEY (never exposed to the browser), and returns trends, signals
// and sources as clean JSON in a single call.
//
// Security:
//  - Rule 1: the Airtable key stays server-side. The browser only ever sees the
//    JSON this returns. No secret is required to READ (this is non-sensitive
//    travel-industry intelligence), but write actions (collect/synthesise) remain
//    CRON_SECRET-protected in their own endpoints.
//  - Rule 7: fails closed — any Airtable error returns 500 with a generic message.
//  - CORS: locked to the Trends own domains (no Access-Control-Allow-Origin: *).

const BASE_ID = 'appts2EjZ65zLeXl7';
const TABLES = {
  sources: 'tblCiANWGoKlpuFxn',
  signals: 'tblghkLE4lZMvCRqx',
  trends: 'tbl7RKKCjLk6qsEkK'
};

// Field IDs — stable even if someone renames a column in the grid. We read
// with returnFieldsByFieldId=true so records come back keyed by these IDs.
const F = {
  trends: {
    name: 'fldzA7SQYJsQbWvpV',
    description: 'fldUjBBEr1mAmjzSY',
    score: 'fldtgPosIIWqhkMBc',
    direction: 'fld2ogC6LjXyCbl6o',
    type: 'fld7rHmXboz9jNbBz',
    destinations: 'fldznEV6SPRYA0MUA',
    signalCount: 'fldB71ix4xCXbWG9N',
    status: 'fldY8HeeDC8NRyBXU',
    marketingActions: 'fldIvvVkvgyHuYwZr',
    lastUpdated: 'fld1cLC4x26rcGQjm'
  },
  signals: {
    title: 'fldb16Yn717CrfXqw',
    summary: 'fldLPLo2q3T0mDZH2',
    signalType: 'fldXPDo5aJBKDEPP0',
    destinations: 'fldLI74PYa0K8jKCr',
    relevance: 'fldFHbh1RHbZobhqW',
    processed: 'fldPbQd52N1xHfw3u',
    sourceUrl: 'fldRHbVVdAEN3aUaP',
    detectedAt: 'fldmPEkccSm8UVef8'
  },
  sources: {
    name: 'fldABVwNtm1jM8RY4',
    category: 'fldWCBsEKabvR8MF9',
    type: 'flddNuYJ0CvLFmu2f',
    status: 'fld94w4Jm6IUakVun',
    checkFrequency: 'fldKxq01qvPfyhPMr'
  }
};

const ALLOWED_ORIGINS = [
  'https://trends.travelify.io',
  'https://luna-trends.vercel.app'
];

async function airtableFetch(endpoint) {
  const res = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${endpoint}`, {
    headers: {
      'Authorization': `Bearer ${process.env.AIRTABLE_KEY}`,
      'Content-Type': 'application/json'
    }
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Airtable GET ${endpoint}: ${res.status} ${err}`);
  }
  return res.json();
}

// Pull every page of a table (Airtable caps at 100 records/page).
async function fetchAll(table, params = []) {
  let records = [];
  let offset = null;
  do {
    const all = [...params];
    if (offset) all.push(`offset=${offset}`);
    const qs = all.length ? `?${all.join('&')}` : '';
    const data = await airtableFetch(`${table}${qs}`);
    records = records.concat(data.records || []);
    offset = data.offset || null;
  } while (offset);
  return records;
}

module.exports = async function handler(req, res) {
  // CORS — lock to known origins, fail closed for others.
  const origin = req.headers?.origin || '';
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    return res.status(204).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Trends — read by field ID (synthesise.js writes by ID), sorted by score desc.
    const trendRecords = await fetchAll(TABLES.trends, [
      'returnFieldsByFieldId=true',
      `sort[0][field]=${F.trends.score}`,
      'sort[0][direction]=desc'
    ]);

    // Signals — newest first, most recent 100.
    const signalRecords = await fetchAll(TABLES.signals, [
      'returnFieldsByFieldId=true',
      `sort[0][field]=${F.signals.detectedAt}`,
      'sort[0][direction]=desc',
      'maxRecords=100'
    ]);

    // Sources — read by NAME (collect.js writes Last Checked by name; all source
    // field names are stable and confirmed). Gives us Last Checked for free.
    const sourceRecords = await fetchAll(TABLES.sources);

    const trends = trendRecords.map(r => ({
      id: r.id,
      name: r.fields[F.trends.name] || 'Untitled',
      description: r.fields[F.trends.description] || '',
      score: r.fields[F.trends.score] ?? null,
      direction: r.fields[F.trends.direction] || '',
      type: r.fields[F.trends.type] || '',
      destinations: r.fields[F.trends.destinations] || [],
      signalCount: r.fields[F.trends.signalCount] ?? null,
      status: r.fields[F.trends.status] || '',
      marketingActions: r.fields[F.trends.marketingActions] || '',
      lastUpdated: r.fields[F.trends.lastUpdated] || null
    }));

    const signals = signalRecords.map(r => ({
      id: r.id,
      title: r.fields[F.signals.title] || 'Untitled',
      summary: r.fields[F.signals.summary] || '',
      signalType: r.fields[F.signals.signalType] || '',
      destinations: r.fields[F.signals.destinations] || [],
      relevance: r.fields[F.signals.relevance] ?? null,
      processed: !!r.fields[F.signals.processed],
      sourceUrl: r.fields[F.signals.sourceUrl] || '',
      detectedAt: r.fields[F.signals.detectedAt] || null
    }));

    const sources = sourceRecords.map(r => ({
      id: r.id,
      name: r.fields['Name'] || 'Untitled',
      category: r.fields['Category'] || '',
      type: r.fields['Type'] || '',
      status: r.fields['Status'] || '',
      checkFrequency: r.fields['Check Frequency'] || '',
      lastChecked: r.fields['Last Checked'] || null
    }));

    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');

    return res.status(200).json({
      ok: true,
      generatedAt: new Date().toISOString(),
      counts: {
        trends: trends.length,
        activeTrends: trends.filter(t => t.status === 'Active').length,
        signals: signals.length,
        unprocessedSignals: signals.filter(s => !s.processed).length,
        sources: sources.length,
        activeSources: sources.filter(s => s.status === 'Active').length
      },
      trends,
      signals,
      sources
    });
  } catch (err) {
    console.error('[dashboard-data] error:', err.message);
    return res.status(500).json({ ok: false, error: 'Failed to load dashboard data' });
  }
};
