'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
let tokenCalls = 0;
let registrationCalls = 0;
const fixtureToken = (suffix) => ['anonymous', suffix].join('-');
const server = http.createServer(async (req, res) => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = (status, value) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(value));
  };
  if (req.url === '/wrong-resource') {
    res.writeHead(401, { 'WWW-Authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/wrong-resource"` });
    return res.end();
  }
  if (req.url.startsWith('/.well-known/oauth-protected-resource')) {
    return send(200, { resource: req.url.includes('wrong-resource') ? 'https://wrong.example/mcp' : `${base}/mcp`, authorization_servers: [base], scopes_supported: ['read'] });
  }
  if (req.url === '/.well-known/oauth-authorization-server') {
    return send(200, {
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
      authorization_response_iss_parameter_supported: true,
    });
  }
  if (req.url === '/register') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const registration = JSON.parse(Buffer.concat(chunks).toString());
    if (req.method !== 'POST' || req.headers.authorization ||
        registration.token_endpoint_auth_method !== 'none' ||
        registration.redirect_uris?.[0] !== 'http://127.0.0.1:54321/callback') {
      return send(400, { error: 'invalid_client_metadata' });
    }
    registrationCalls++;
    return send(201, { client_id: 'anonymous-public', ...registration });
  }
  if (req.url === '/token') {
    tokenCalls++;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const params = new URLSearchParams(Buffer.concat(chunks).toString());
    if (req.method !== 'POST' || req.headers.authorization ||
        !req.headers['content-type']?.startsWith('application/x-www-form-urlencoded') ||
        params.get('resource') !== `${base}/mcp` || params.get('client_id') !== 'anonymous-public') {
      return send(400, { error: 'invalid_request' });
    }
    if (params.get('grant_type') === 'refresh_token') {
      if (params.get('refresh_token') !== 'anonymous-refresh') return send(400, { error: 'invalid_grant' });
      return send(200, { access_token: fixtureToken('refreshed'), token_type: 'Bearer', expires_in: 3600 });
    }
    const verifier = params.get('code_verifier');
    if (params.get('code') !== 'anonymous-code' || !verifier || verifier.length < 43 ||
        params.get('redirect_uri') !== 'http://127.0.0.1:54321/callback') {
      return send(400, { error: 'invalid_grant' });
    }
    return send(200, {
      access_token: fixtureToken('access'), refresh_token: fixtureToken('refresh'),
      token_type: 'Bearer', expires_in: 3600,
      fixture_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
    });
  }
  if (req.url === '/stats') return send(200, { tokenCalls, registrationCalls });
  if (req.url === '/redirect') {
    res.writeHead(302, { Location: `${base}/token` });
    return res.end();
  }
  if (req.url === '/large') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end('x'.repeat(1024 * 1024 + 1));
  }
  if (req.url === '/wait') return setTimeout(() => send(200, {}), 5000);
  send(404, { error: 'not_found' });
});
server.listen(0, '127.0.0.1', () => process.stdout.write(`http://127.0.0.1:${server.address().port}/mcp\n`));
