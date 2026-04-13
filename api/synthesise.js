const BASE_ID = 'appts2EjZ65zLeXl7';
const TABLES = {
  signals: 'tblghkLE4lZMvCRqx',
  trends: 'tbl7RKKCjLk6qsEkK'
};
const FIELDS = {
  signals: {
    title: 'fldb16Yn717CrfXqw',
    summary: 'fldLPLo2q3T0mDZH2',
    signalType: 'fldXPDo5aJBKDEPP0',
    destinations: 'fldLI74PYa0K8jKCr',
    relevance: 'fldFHbh1RHbZobhqW',
    processed: 'fldPbQd52N1xHfw3u',
    airlines: 'fldtZi6BARoKksqcu',
    sourceUrl: 'fldRHbVVdAEN3aUaP',
    detectedAt: 'fldmPEkccSm8UVef8'
  },
  trends: {
    name: 'fldzA7SQYJsQbWvpV',
    description: 'fldUjBBEr1mAmjzSY',
    compositeScore: 'fldtgPosIIWqhkMBc',
    direction: 'fld2ogC6LjXyCbl6o',
    destinations: 'fldznEV6SPRYA0MUA',
    signalCount: 'fldB71ix4xCXbWG9N',
    firstDetected: 'fldnlMwTsSkJc7gbJ',
    lastUpdated: 'fld1cLC4x26rcGQjm',
    status: 'fldY8HeeDC8NRyBXU',
    trendType: 'fld7rHmXboz9jNbBz',
    marketingActions: 'fldIvvVkvgyHuYwZr',
    signalIds: 'fldea16xw4r1Qhuwc'
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
    throw new Error(`Airtable ${method}: ${res.status} ${err}`);
  }
  return res.json();
}

async function getUnprocessedSignals() {
  const data = await airtableFetch(
    `${TABLES.signals}?filterByFormula=NOT({Processed})&sort[0][field]=${FIELDS.signals.detectedAt}&sort[0][direction]=desc&maxRecords=50`
  );
  return data.records || [];
}

async function markSignalsProcessed(recordIds) {
  for (let i = 0; i < recordIds.length; i += 10) {
    const batch = recordIds.slice(i, i + 10).map(id => ({
      id,
      fields: { [FIELDS.signals.processed]: true }
    }));
    await airtableFetch(TABLES.signals, 'PATCH', { records: batch });
  }
}

async function synthesiseWithClaude(signals) {
  const signalSummaries = signals.map(s => ({
    id: s.id,
    title: s.fields[FIELDS.signals.title],
    summary: s.fields[FIELDS.signals.summary],
    type: s.fields[FIELDS.signals.signalType]?.name || s.fields[FIELDS.signals.signalType] || 'Unknown',
    destinations: (s.fields[FIELDS.signals.destinations] || []).map(d => d.name || d),
    airlines: (s.fields[FIELDS.signals.airlines] || []).map(a => a.name || a),
    relevance: s.fields[FIELDS.signals.relevance] || 5
  }));

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: `You are a travel industry trend analyst working for Travelgenix, a UK travel technology company serving SME travel agents.

Analyse these ${signalSummaries.length} recent signals and identify distinct trends. Group related signals together. Respond ONLY with valid JSON, no markdown backticks.

Signals:
${JSON.stringify(signalSummaries, null, 2)}

Respond with this exact JSON structure:
{
  "trends": [
    {
      "name": "Short descriptive name for the trend",
      "description": "2-4 sentence explanation of what is happening, why it matters to UK travel agents, and what they should do about it",
      "trendType": "one of: Destination Demand, New Route, Seasonal Window, Event-Driven, Social Viral, Industry Shift, Competitor Alert, FCDO Opportunity",
      "direction": "one of: Rising, Stable, Falling",
      "compositeScore": 7.5,
      "destinations": ["array of destination names"],
      "signalIds": ["array of signal IDs that support this trend"],
      "marketingActions": [
        {
          "type": "Social Post or Blog Article or Landing Page Update or Email Campaign",
          "headline": "Suggested headline",
          "brief": "One paragraph content brief"
        }
      ]
    }
  ]
}

Rules:
- Only create trends with 2+ supporting signals, OR a single signal with relevance 8+
- compositeScore is 1-10 where 10 = massive opportunity for UK travel agents
- Group signals about the same destination, airline, or theme together
- Marketing actions must be specific and actionable, not generic
- If there are no meaningful trends, return {"trends": []}`
      }]
    })
  });

  const data = await response.json();
  const text = (data.content || []).map(b => b.text || '').join('');
  try {
    return JSON.parse(text.replace(/```json|```/g, '').trim());
  } catch (e) {
    console.error('Claude synthesis parse error:', text.substring(0, 300));
    return { trends: [] };
  }
}

module.exports = async function handler(req, res) {
  const secret = req.query?.secret || req.headers?.['x-cron-secret'];
  if (secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const results = { signalsProcessed: 0, trendsCreated: 0, errors: [] };

  try {
    const signals = await getUnprocessedSignals();
    if (signals.length === 0) {
      return res.status(200).json({ ...results, message: 'No unprocessed signals' });
    }

    console.log(`Synthesising ${signals.length} unprocessed signals`);
    const synthesis = await synthesiseWithClaude(signals);

    for (const trend of (synthesis.trends || [])) {
      try {
        const trendRecord = {
          [FIELDS.trends.name]: trend.name,
          [FIELDS.trends.description]: trend.description,
          [FIELDS.trends.compositeScore]: trend.compositeScore || 5,
          [FIELDS.trends.direction]: trend.direction || 'Rising',
          [FIELDS.trends.signalCount]: (trend.signalIds || []).length,
          [FIELDS.trends.firstDetected]: new Date().toISOString().split('T')[0],
          [FIELDS.trends.lastUpdated]: new Date().toISOString(),
          [FIELDS.trends.status]: 'Active',
          [FIELDS.trends.trendType]: trend.trendType || 'Industry Shift',
          [FIELDS.trends.signalIds]: (trend.signalIds || []).join(', '),
          [FIELDS.trends.marketingActions]: JSON.stringify(trend.marketingActions || [], null, 2)
        };

        if (trend.destinations && trend.destinations.length > 0) {
          trendRecord[FIELDS.trends.destinations] = trend.destinations.slice(0, 8);
        }

        await airtableFetch(TABLES.trends, 'POST', {
          records: [{ fields: trendRecord }],
          typecast: true
        });
        results.trendsCreated++;
      } catch (e) {
        console.error(`Error creating trend "${trend.name}":`, e.message);
        results.errors.push(`Trend "${trend.name}": ${e.message}`);
      }
    }

    const signalIds = signals.map(s => s.id);
    await markSignalsProcessed(signalIds);
    results.signalsProcessed = signalIds.length;

  } catch (e) {
    results.errors.push(`Fatal: ${e.message}`);
    console.error('Synthesis error:', e);
  }

  console.log('Synthesis complete:', results);
  return res.status(200).json(results);
};
