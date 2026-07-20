/* Netlify serverless proxy — keeps the Airtable PAT server-side.
   Receives requests from the portal, forwards them to Airtable,
   and returns the response. The PAT never reaches the browser. */
exports.handler = async function (event) {
  const PAT = process.env.AIRTABLE_PAT;

  if (!PAT) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: { message: 'AIRTABLE_PAT environment variable is not set in Netlify.' } })
    };
  }

  /* The portal passes the Airtable path as ?_path=/appXXX/tblXXX[/recXXX] */
  const airtablePath = event.queryStringParameters?._path || '';

  /* Security: only allow requests to the ACE base */
  if (!airtablePath.startsWith('/appFVg5UNlwzJMuaY/')) {
    return {
      statusCode: 403,
      body: JSON.stringify({ error: { message: 'Forbidden — unknown base.' } })
    };
  }

  /* Strip _path from the raw query string, preserve everything else (filters, fields, offset) */
  const rawQuery = event.rawQuery || '';
  const cleanQuery = rawQuery.replace(/(?:^|&)_path=[^&]*/g, '').replace(/^&/, '');
  const airtableUrl = 'https://api.airtable.com/v0' + airtablePath + (cleanQuery ? '?' + cleanQuery : '');

  const fetchOptions = {
    method: event.httpMethod,
    headers: {
      'Authorization': 'Bearer ' + PAT,
      'Content-Type': 'application/json'
    }
  };

  if (event.body && !['GET', 'HEAD'].includes(event.httpMethod)) {
    fetchOptions.body = event.body;
  }

  try {
    const response = await fetch(airtableUrl, fetchOptions);
    const body = await response.text();
    return {
      statusCode: response.status,
      headers: { 'Content-Type': 'application/json' },
      body
    };
  } catch (err) {
    return {
      statusCode: 502,
      body: JSON.stringify({ error: { message: 'Proxy error: ' + err.message } })
    };
  }
};
