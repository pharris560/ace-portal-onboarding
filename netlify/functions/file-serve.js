/* Serves files stored in Netlify Blobs so Airtable can download them
   when processing attachment URLs in PATCH requests. */
const { getStore } = require('@netlify/blobs');

exports.handler = async function(event) {
  const key = event.queryStringParameters?.key;
  if (!key) return { statusCode: 400, body: 'Missing key parameter.' };

  try {
    const siteID = process.env.SITE_ID || process.env.NETLIFY_SITE_ID;
    const token  = process.env.NETLIFY_PERSONAL_TOKEN;
    const store = getStore({ name: 'ace-uploads', siteID, token });
    const entry = await store.getWithMetadata(key, { type: 'arrayBuffer' });

    if (!entry || !entry.data) {
      return { statusCode: 404, body: 'File not found or expired.' };
    }

    const { data, metadata } = entry;
    return {
      statusCode: 200,
      headers: {
        'Content-Type': metadata?.contentType || 'application/octet-stream',
        'Content-Disposition': 'inline; filename="' + (metadata?.filename || 'file') + '"',
        'Cache-Control': 'no-store'
      },
      body: Buffer.from(data).toString('base64'),
      isBase64Encoded: true
    };
  } catch (err) {
    return { statusCode: 500, body: 'Server error: ' + err.message };
  }
};
