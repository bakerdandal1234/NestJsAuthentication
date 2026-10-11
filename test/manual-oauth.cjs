require('reflect-metadata');
const path = require('node:path');
const { readFile } = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const { createInterface } = require('node:readline');
const { parse } = require('dotenv');
const { createOAuthApp } = require('./helpers/oauth-app.cjs');
const { startPostgres, stopPostgres } = require('./helpers/postgres.cjs');

async function manualOAuth() {
  const config = parse(await readFile(path.join(__dirname, '..', '.env')));
  const frontendRoot = path.resolve(__dirname, '..', '..', 'my-app-frontend');
  if (config.FRONTEND_URL !== 'http://localhost:5173')
    throw new Error('Manual check requires FRONTEND_URL=http://localhost:5173');
  for (const provider of ['GOOGLE', 'GITHUB']) {
    const expected = `http://localhost:3000/v1/auth/${provider.toLowerCase()}/callback`;
    if (config[`${provider}_CALLBACK_URL`] !== expected)
      throw new Error(
        `Manual check requires ${provider}_CALLBACK_URL=${expected}`,
      );
    if (
      !config[`${provider}_CLIENT_ID`] ||
      !config[`${provider}_CLIENT_SECRET`]
    )
      throw new Error(`${provider} credentials are not configured`);
  }
  // Real provider credentials are used only with a disposable local database.
  config.NODE_ENV = 'development';
  let postgres;
  let application;
  let frontend;
  try {
    console.log(
      'Preparing disposable PostgreSQL; the application database is not used.',
    );
    postgres = await startPostgres();
    application = await createOAuthApp({
      connection: postgres.connection,
      config,
      port: 3000,
      throttleLimit: 60,
    });
    const importFrontend = (relativePath) =>
      import(
        pathToFileURL(path.join(frontendRoot, 'node_modules', relativePath))
          .href
      );
    const [{ createServer }, react, tailwindcss] = await Promise.all([
      importFrontend('vite/dist/node/index.js'),
      importFrontend('@vitejs/plugin-react/dist/index.js'),
      importFrontend('@tailwindcss/vite/dist/index.mjs'),
    ]);
    frontend = await createServer({
      configFile: false,
      root: frontendRoot,
      cacheDir: path.join(postgres.directory, 'vite-cache'),
      plugins: [react.default(), tailwindcss.default()],
      define: {
        'import.meta.env.VITE_API_URL': JSON.stringify(
          'http://localhost:3000/v1',
        ),
      },
      server: { host: '127.0.0.1', port: 5173, strictPort: true },
    });
    await frontend.listen();
    application.app.getHttpServer().on('request', (request, response) => {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      const watched = [
        '/v1/auth/google/callback',
        '/v1/auth/github/callback',
        '/v1/auth/oauth/exchange',
        '/v1/users/me',
      ];
      if (watched.includes(pathname))
        response.once('finish', () =>
          console.log(
            `Browser check: ${pathname} -> HTTP ${response.statusCode}`,
          ),
        );
    });
    console.log('READY: http://localhost:5173/login');
    console.log(
      'Use Google, log out, then GitHub. No credentials or tokens are printed.',
    );
    console.log(
      'Type stop or press Ctrl+C to stop and remove the disposable database.',
    );
    const input = createInterface({ input: process.stdin });
    await new Promise((resolve) => {
      input.on('line', (line) => {
        if (line.trim() === 'stop') resolve();
      });
      process.once('SIGINT', resolve);
      process.once('SIGTERM', resolve);
    });
    input.close();
  } finally {
    try {
      if (frontend) await frontend.close();
    } finally {
      try {
        if (application) await application.app.close();
      } finally {
        if (postgres) await stopPostgres(postgres.directory);
      }
    }
  }
}

manualOAuth().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
