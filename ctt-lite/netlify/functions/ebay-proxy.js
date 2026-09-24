// CTT Lite — eBay proxy (Netlify Function)
//
// Exact copy of the already-working proxy behind the standalone
// listing-tool.html (supplied by Brody, 2026-09-12) — reused byte-for-byte
// rather than rewritten, since it's proven against the real eBay Trading
// API in production. Deliberately credential-free: the eBay auth token and
// imgBB key are sent per-request from the browser (stored in the browser's
// own localStorage — see js/ebay.js), never as server-side env vars, so
// there is nothing to configure on this Netlify site beyond deploying the
// file itself.
//
// Two modes, dispatched by `action` in the POST body:
//   - { action: "upload_photo", driveUrl, imgbbKey } — fetches a Drive
//     thumbnail server-side (dodging Drive's CORS policy) and relays it to
//     imgBB. Used only for the CTT store photo, which lives on Drive.
//     Local files the user drags in are uploaded straight to imgBB from
//     the browser instead — no proxy hop needed for those.
//   - { xml, callName } — generic eBay Trading API passthrough. Posts the
//     given XML to api.ebay.com/ws/api.dll with the call-name header set;
//     all eBay auth (RequesterCredentials/eBayAuthToken) travels inside
//     the XML body itself, built client-side.

exports.handler = async function(event, context) {

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    const body = JSON.parse(event.body);

    // ── PHOTO UPLOAD MODE ──────────────────────────────────────────
    // Fetches a Drive thumbnail server-side (no CORS) and uploads to imgBB
    if (body.action === 'upload_photo') {
      const { driveUrl, imgbbKey } = body;

      // Fetch the image from Drive on the server side
      const imgResp = await fetch(driveUrl);
      if (!imgResp.ok) {
        return {
          statusCode: 200,
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ success: false, error: 'Failed to fetch Drive image: ' + imgResp.status })
        };
      }

      // Convert to base64
      const arrayBuffer = await imgResp.arrayBuffer();
      const base64 = Buffer.from(arrayBuffer).toString('base64');

      // Upload to imgBB
      const formData = new URLSearchParams();
      formData.append('key', imgbbKey);
      formData.append('image', base64);

      const imgbbResp = await fetch('https://api.imgbb.com/1/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formData.toString()
      });
      const imgbbData = await imgbbResp.json();

      return {
        statusCode: 200,
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          success: imgbbData.success,
          url: imgbbData.success ? imgbbData.data.url : null,
          error: imgbbData.success ? null : JSON.stringify(imgbbData.error)
        })
      };
    }

    // ── EBAY API MODE ──────────────────────────────────────────────
    const xml = body.xml;
    const callName = body.callName || 'AddItem';

    if (!xml) {
      return {
        statusCode: 400,
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'No XML provided' })
      };
    }

    const response = await fetch('https://api.ebay.com/ws/api.dll', {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml',
        'X-EBAY-API-COMPATIBILITY-LEVEL': '1155',
        'X-EBAY-API-CALL-NAME': callName,
        'X-EBAY-API-SITEID': '0'
      },
      body: xml
    });

    const responseText = await response.text();

    return {
      statusCode: 200,
      headers: { ...headers, 'Content-Type': 'text/xml' },
      body: responseText
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message })
    };
  }
};
