/* Netlify proxy for Airtable attachment uploads.
   Uses Airtable's native "Upload attachment" API (content.airtable.com), which
   stores the file directly in Airtable and appends it to the field. This removes
   the previous Netlify Blobs + personal-token + file-serve dependency chain
   (which was the cause of uploads hanging on "uploading"). Only the Airtable PAT
   is required — the same one the main airtable.js proxy already uses. */
const https = require('https');
const { scanBuffer } = require('./lib/scan');

const BASE_ID = 'appFVg5UNlwzJMuaY';
const MAX_BYTES = 5 * 1024 * 1024; /* Airtable uploadAttachment limit: 5 MB */

function httpsRequest(options, body) {
  return new Promise((resolve) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', e => resolve({ status: 502, body: JSON.stringify({ error: { message: e.message } }) }));
    if (body) req.end(body); else req.end();
  });
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const PAT = process.env.AIRTABLE_PAT;
  if (!PAT) {
    return { statusCode: 500, body: JSON.stringify({ error: { message: 'AIRTABLE_PAT not set.' } }) };
  }

  let payload;
  try { payload = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: { message: 'Invalid JSON body.' } }) }; }

  const { recordId, fieldId, filename, contentType, base64 } = payload;
  if (!recordId || !fieldId || !filename || !base64) {
    return { statusCode: 400, body: JSON.stringify({ error: { message: 'Missing required fields.' } }) };
  }

  /* Reject oversize files with a clear message instead of failing at Airtable. */
  const approxBytes = Math.floor(base64.length * 3 / 4);
  if (approxBytes > MAX_BYTES) {
    return {
      statusCode: 413,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: { message: 'File is too large (' + (approxBytes / 1048576).toFixed(1) + ' MB). Max is 5 MB — please upload a smaller photo or PDF.' } })
    };
  }

  /* Every file is virus-scanned BEFORE it is stored. Fail closed: no scan, no upload. */
  const scan = await scanBuffer(Buffer.from(base64, 'base64'), filename, contentType);
  if (scan.status === 'infected') {
    return { statusCode: 422, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: { message: 'This file was blocked because the virus scan found a problem (' + scan.virus + '). Please do not upload it. Scan your device and try a different copy of the document.' }, scan: 'infected' }) };
  }
  if (scan.status !== 'clean') {
    return { statusCode: 503, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: { message: 'We could not scan this file for viruses right now, so it was not uploaded. Please try again in a few minutes. (' + scan.reason + ')' }, scan: 'unavailable' }) };
  }

  const body = JSON.stringify({
    contentType: contentType || 'application/octet-stream',
    file: base64,
    filename
  });

  /* POST to Airtable's content API — appends the attachment to the field. */
  const result = await httpsRequest({
    hostname: 'content.airtable.com',
    path: '/v0/' + BASE_ID + '/' + recordId + '/' + encodeURIComponent(fieldId) + '/uploadAttachment',
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + PAT,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    }
  }, body);

  return {
    statusCode: result.status,
    headers: { 'Content-Type': 'application/json' },
    body: result.body || JSON.stringify({ ok: true, scan: 'clean' })
  };
};
