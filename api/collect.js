const Parser = require('rss-parser');
const parser = new Parser({ timeout: 8000 });

const BASE_ID = 'appts2EjZ65zLeXl7';
const TABLES = {
  sources: 'tblCiANWGoKlpuFxn',
  signals: 'tblghkLE4lZMvCRqx'
};
const FIELDS = {
  sources: {
    name: 'fldABVwNtm1jM8RY4',
    category: 'fldWCBsEKabvR8MF9',
    type: 'flddNuYJ0CvLFmu2f',
    url: 'fldW4uGKfGXH5d1tp',
    frequency: 'fldKxq01qvPfyhPMr',
    status: 'fld94w4Jm6IUakVun',
    lastChecked: 'fldteacXzLucsnW6q',
    notes: 'fldguHXzEVblqHF9b'
  },
  signals: {
    title: 'fldb16Yn717CrfXqw',
    summary: 'fldLPLo2q3T0mDZH2',
    sourceName: 'fldVBq7sYrTM9ztAi',
    signalType: 'fldXPDo5aJBKDEPP0',
    destinations: 'fldLI74PYa0K8jKCr',
    airlines: 'fldtZi6BARoKksqcu',
    sourceUrl: 'fldRHbVVdAEN3aUaP',
    detectedAt: 'fldmPEkccSm8UVef8',
    relevance: 'fldFHbh1RHbZobhqW',
    processed: 'fldPbQd52N1xHfw3u',
    rawContent: 'fldEIl9VdV3HOJJJ7'
  }
};

async function airtableFetch(endpoint, method = 'GET', body = null) {
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${process.env.AIRTABLE_KEY}`,
      'Content-Type': 'application/json'
    }
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${endpoint}`, opts);
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Airtable ${method} ${endpoint}: ${res.status} ${err}`);
  }
  return res.json();
}

async function getActiveSources() {
  const data = await airtableFetch(
    `${TABLES.sources}?filterByFormula={Status}='Active'&fields[]=${FIELDS.sources.name}&fields[]=${FIELDS.sources.url}&fields[]=${FIELDS.sources.type}&fields[]=${FIELDS.sources.category}&fields[]=${FIELDS.sources.lastChecked}`
  );
  return data.records || [];
}

async function getRecentSignalUrls() {
  const data = await airtableFetch(
    `${TABLES.signals}?fields[]=${FIELDS.signals.sourceUrl}&sort[0][field]=${FIELDS.signals.detectedAt}&sort[0][direction]=desc&maxRecords=200`
  );
  const urls = new Set();
  (data.records || []).forEach(r => {
    const url = r.fields[FIELDS.signals.sourceUrl];
    if (url) urls.add(url);
  });
  return urls;
}

async function createSignal(signal) {
  return airtableFetch(TABLES.signals, 'POST', {
    records: [{ fields: signal }],
    typecast: true
  });
}

async function updateSourceLastChecked(recordId) {
  return airtableFetch(TABLES.sources, 'PATCH', {
    records: [{
      id: recordId,
      fields: { [FIELDS.sources.lastChecked]: new Date().toISOString() }
    }]
  });
}

async function analyseWithClaude(title, content, sourceName) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 800,
      messages: [{
        role: 'user',
        content: `You are a travel industry analyst. Analyse this news item and respond ONLY with valid JSON, no markdown backticks.

Title: ${title}
Source: ${sourceName}
Content: ${(content || '').substring(0, 1500)}

Respond with this exact JSON structure:
{
  "summary": "2-3 sentence summary of what happened and why it matters to UK travel agents",
  "signalType": "one of: Route Announcement, Destination Trend, Supplier News, FCDO Change, Social Trend, Industry News, Competitor Move, Event, Pricing Signal, Search Spike",
  "destinations": ["array of destination names mentioned, empty if none"],
  "airlines": ["array of airline names mentioned, empty if none"],
  "relevance": 5,
  "isTravel": true
}

Rules:
- relevance is 1-10 where 10 = extremely relevant to UK SME travel agents
- isTravel should be false if the article is not about travel/tourism
- destinations should be specific places (countries, cities, islands) not generic terms
- airlines should be airline brand names only
- summary must explain why a UK travel agent should care`
      }]
    })
  });

  const data = await response.json();
  const text = (data.content || []).map(b => b.text || '').join('');
  try {
    return JSON.parse(text.replace(/```json|```/g, '').trim());
  } catch (e) {
    console.error('Claude parse error:', text.substring(0, 200));
    return null;
  }
}

async function collectFromRSS(source, existingUrls) {
  const url = source.fields[FIELDS.sources.url];
  const name = source.fields[FIELDS.sources.name];
  if (!url) return [];

  let feed;
  try {
    feed = await parser.parseURL(url);
  } catch (e) {
    console.error(`RSS fetch failed for ${name}: ${e.message}`);
    return [];
  }

  const newItems = (feed.items || []).slice(0, 10).filter(item => {
    const link = item.link || item.guid || '';
    return link && !existingUrls.has(link);
  });

  const signals = [];
  for (const item of newItems.slice(0, 3)) {
    const title = item.title || 'Untitled';
    const content = item.contentSnippet || item.content || item.description || '';
    const link = item.link || item.guid || '';

    const analysis = await analyseWithClaude(title, content, name);
    if (!analysis || !analysis.isTravel) continue;
    if (analysis.relevance < 3) continue;

    const signal = {
      [FIELDS.signals.title]: title.substring(0, 250),
      [FIELDS.signals.summary]: analysis.summary || '',
      [FIELDS.signals.sourceName]: name,
      [FIELDS.signals.signalType]: analysis.signalType || 'Industry News',
      [FIELDS.signals.sourceUrl]: link,
      [FIELDS.signals.detectedAt]: new Date().toISOString(),
      [FIELDS.signals.relevance]: analysis.relevance || 5,
      [FIELDS.signals.processed]: false,
      [FIELDS.signals.rawContent]: content.substring(0, 2000)
    };

    if (analysis.destinations && analysis.destinations.length > 0) {
      signal[FIELDS.signals.destinations] = analysis.destinations.slice(0, 5);
    }
    if (analysis.airlines && analysis.airlines.length > 0) {
      signal[FIELDS.signals.airlines] = analysis.airlines.slice(0, 5);
    }

    signals.push(signal);
  }

  return signals;
}

module.exports = async function handler(req, res) {
  const secret = req.query?.secret || req.headers?.['x-cron-secret'];
  if (secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const startTime = Date.now();
  const results = { sourcesChecked: 0, signalsCreated: 0, errors: [] };

  try {
    const [sources, existingUrls] = await Promise.all([
      getActiveSources(),
      getRecentSignalUrls()
    ]);

    const rssSources = sources.filter(s =>
      s.fields[FIELDS.sources.type]?.name === 'RSS' ||
      s.fields[FIELDS.sources.type] === 'RSS'
    );

    console.log(`Found ${rssSources.length} active RSS sources, ${existingUrls.size} existing signal URLs`);

    for (const source of rssSources) {
      const name = source.fields[FIELDS.sources.name];
      try {
        const signals = await collectFromRSS(source, existingUrls);

        for (const signal of signals) {
          await createSignal(signal);
          existingUrls.add(signal[FIELDS.signals.sourceUrl]);
          results.signalsCreated++;
        }

        await updateSourceLastChecked(source.id);
        results.sourcesChecked++;
        console.log(`${name}: ${signals.length} new signals`);

        if (Date.now() - startTime > 50000) {
          console.log('Time limit approaching, stopping early');
          break;
        }
      } catch (e) {
        console.error(`Error processing ${name}:`, e.message);
        results.errors.push(`${name}: ${e.message}`);
      }
    }
  } catch (e) {
    results.errors.push(`Fatal: ${e.message}`);
    console.error('Fatal error:', e);
  }

  results.duration = `${((Date.now() - startTime) / 1000).toFixed(1)}s`;
  console.log('Collection complete:', results);

  return res.status(200).json(results);
};
