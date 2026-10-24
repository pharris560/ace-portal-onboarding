/* Virus scan for every uploaded file (Cloudmersive "advanced" scan, strict defaults: executables,
   scripts, macros, password-protected, invalid and unsafe-archive files are all rejected).
   FAIL CLOSED: if the scanner key is missing or the scanner cannot be reached, the file is NOT
   accepted. The key lives only in the Netlify environment as CLOUDMERSIVE_API_KEY. */
const https = require('https');

const HOST = 'api.cloudmersive.com';
const PATH = '/virus/scan/file/advanced';

function multipart(buffer, filename, contentType) {
  const boundary = '----aceScan' + Math.random().toString(16).slice(2);
  const safe = String(filename || 'file').replace(/[^\w.\- ]/g, '_').slice(0, 120);
  const head = Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="inputFile"; filename="' + safe + '"\r\nContent-Type: ' + (contentType || 'application/octet-stream') + '\r\n\r\n');
  const tail = Buffer.from('\r\n--' + boundary + '--\r\n');
  return { boundary, body: Buffer.concat([head, buffer, tail]) };
}

/* Resolves to { status: 'clean' } | { status: 'infected', virus } | { status: 'unavailable', reason }.
   `restrictFileTypes` (e.g. '.pdf,.png') is optional. Never throws. */
function scanBuffer(buffer, filename, contentType, restrictFileTypes) {
  const key = process.env.CLOUDMERSIVE_API_KEY;
  if (!key) return Promise.resolve({ status: 'unavailable', reason: 'Virus scanning is not set up yet.' });
  const { boundary, body } = multipart(buffer, filename, contentType);
  const headers = { Apikey: key, 'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Content-Length': body.length, fileName: String(filename || 'file').replace(/[^\w.\- ]/g, '_').slice(0, 120) };
  if (restrictFileTypes) headers.restrictFileTypes = restrictFileTypes;
  return new Promise((resolve) => {
    const req = https.request({ hostname: HOST, path: PATH, method: 'POST', headers, timeout: 25000 }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve({ status: 'unavailable', reason: 'The virus scanner returned an error (' + res.statusCode + ').' });
        let j; try { j = JSON.parse(data); } catch (_) { return resolve({ status: 'unavailable', reason: 'The virus scanner gave an unreadable answer.' }); }
        if (j && j.CleanResult === true) return resolve({ status: 'clean' });
        if (j && j.CleanResult === false) {
          const v = Array.isArray(j.FoundViruses) && j.FoundViruses[0] ? j.FoundViruses[0].VirusName : '';
          return resolve({ status: 'infected', virus: v || 'unsafe file' });
        }
        resolve({ status: 'unavailable', reason: 'The virus scanner gave an unclear answer.' });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 'unavailable', reason: 'The virus scanner took too long.' }); });
    req.on('error', () => resolve({ status: 'unavailable', reason: 'Could not reach the virus scanner.' }));
    req.end(body);
  });
}

module.exports = { scanBuffer };
