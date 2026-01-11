const https = require('https');

const url = 'https://x-series-api.lightspeedhq.com/reference/createupdateregistersale';

function fetch(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve(data));
      })
      .on('error', reject);
  });
}

function extractSchemaEncoded(html) {
  const marker = '&quot;path&quot;:&quot;/register_sales&quot;,&quot;schema&quot;:';
  const idx = html.indexOf(marker);
  if (idx < 0) throw new Error('marker not found');

  const start = html.indexOf('{', idx + marker.length);
  if (start < 0) throw new Error('start brace not found');

  let depth = 0;
  let end = -1;
  for (let i = start; i < html.length; i += 1) {
    const ch = html[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end < 0) throw new Error('end brace not found');
  return html.slice(start, end);
}

function decodeEntities(text) {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;/g, "'");
}

(async () => {
  const html = await fetch(url);
  const schemaEncoded = extractSchemaEncoded(html);
  const schemaJsonText = decodeEntities(schemaEncoded);
  const schema = JSON.parse(schemaJsonText);

  const endpoint = schema?.paths?.['/register_sales']?.post;
  if (!endpoint) {
    console.error('endpoint not found; keys:', Object.keys(schema?.paths || {}).slice(0, 20));
    process.exit(1);
  }

  const req = endpoint.requestBody;
  const reqSchema = req?.content?.['application/json']?.schema;
  const resolved = { reqSchema };

  if (reqSchema && reqSchema.$ref) {
    const refName = reqSchema.$ref.split('/').pop();
    resolved.refName = refName;
    resolved.definition = schema?.components?.schemas?.[refName] || null;
  }

  console.log(JSON.stringify({
    requestBodyRequired: req?.required ?? null,
    requestBodySchema: resolved,
    topLevelRequestKeys: resolved.definition ? Object.keys(resolved.definition.properties || {}) : null,
    requiredFields: resolved.definition?.required || null
  }, null, 2));
})();
