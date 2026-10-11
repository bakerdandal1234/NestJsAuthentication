const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { randomUUID } = require('node:crypto');

async function startOAuthProvider() {
  const authorizations = new Map();
  const accessTokens = new Map();
  let tokenRequests = 0;
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      const [provider, endpoint] = url.pathname.slice(1).split('/');
      if (endpoint === 'token') {
        tokenRequests += 1;
        let body = '';
        for await (const chunk of request) body += chunk;
        const form = new URLSearchParams(body);
        const identity = authorizations.get(form.get('code'));
        assert.equal(form.get('grant_type'), 'authorization_code');
        assert.equal(form.get('client_id'), `${provider}-test-client`);
        assert.equal(form.get('client_secret'), `${provider}-test-secret`);
        assert.equal(identity?.provider, provider);
        authorizations.delete(form.get('code'));
        const accessToken = randomUUID();
        accessTokens.set(accessToken, identity);
        response.setHeader('Content-Type', 'application/json');
        response.end(
          JSON.stringify({ access_token: accessToken, token_type: 'bearer' }),
        );
        return;
      }
      const token =
        request.headers.authorization?.replace(/^Bearer /i, '') ||
        url.searchParams.get('access_token');
      const identity = accessTokens.get(token);
      assert.equal(identity?.provider, provider);
      const profile =
        endpoint === 'emails'
          ? [
              {
                email: identity.email,
                primary: true,
                verified: identity.verified,
              },
            ]
          : provider === 'google'
            ? {
                sub: identity.id,
                email: identity.email,
                email_verified: identity.verified,
                given_name: 'OAuth',
                family_name: 'Test',
              }
            : { id: identity.id, login: identity.id, name: 'OAuth Test' };
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(profile));
    } catch (error) {
      response.statusCode = 400;
      response.end(
        JSON.stringify({
          error: 'invalid_grant',
          error_description: error.message,
        }),
      );
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    configure(strategy, provider) {
      // Only the provider HTTP boundary is redirected; Passport and application code run unchanged.
      strategy._oauth2._authorizeUrl = `${origin}/${provider}/authorize`;
      strategy._oauth2._accessTokenUrl = `${origin}/${provider}/token`;
      strategy._userProfileURL = `${origin}/${provider}/userinfo`;
      if (provider === 'github')
        strategy._userEmailURL = `${origin}/github/emails`;
    },
    authorize(provider, identity) {
      const code = randomUUID();
      authorizations.set(code, {
        provider,
        id: randomUUID(),
        email: `${randomUUID()}@example.test`,
        verified: true,
        ...identity,
      });
      return code;
    },
    get tokenRequests() {
      return tokenRequests;
    },
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

module.exports = { startOAuthProvider };
