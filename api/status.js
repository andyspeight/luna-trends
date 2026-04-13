const BASE_ID = 'appts2EjZ65zLeXl7';

async function airtableFetch(endpoint) {
  const res = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${endpoint}`, {
    headers: { 'Authorization': `Bearer ${process.env.AIRTABLE_KEY}` }
  });
  if (!res.ok) throw new Error(`Airtable: ${res.status}`);
  return res.json();
}

module.exports = async function handler(req, res) {
  const secret = req.query?.secret || req.headers?.['x-cron-secret'];
  if (secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const [sources, signals, trends] = await Promise.all([
      airtableFetch('tblCiANWGoKlpuFxn?maxRecords=1&fields[]=fldABVwNtm1jM8RY4'),
      airtableFetch('tblghkLE4lZMvCRqx?maxRecords=1&fields[]=fldb16Yn717CrfXqw'),
      airtableFetch('tbl7RKKCjLk6qsEkK?maxRecords=1&fields[]=fldzA7SQYJsQbWvpV')
    ]);

    return res.status(200).json({
      status: 'healthy',
      product: 'Luna Trends',
      version: '1.0.0',
      timestamp: new Date().toISOString(),
      tables: {
        sources: sources.records ? 'connected' : 'error',
        signals: signals.records ? 'connected' : 'error',
        trends: trends.records ? 'connected' : 'error'
      }
    });
  } catch (e) {
    return res.status(500).json({
      status: 'error',
      error: e.message,
      timestamp: new Date().toISOString()
    });
  }
};
