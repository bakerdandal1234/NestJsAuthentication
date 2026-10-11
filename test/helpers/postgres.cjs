const { execFile, spawn } = require('node:child_process');
const { mkdtemp, rm } = require('node:fs/promises');
const { createServer } = require('node:net');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');

const runPostgresTool = promisify(execFile);

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

async function startPostgres() {
  const directory = await mkdtemp(
    path.join(tmpdir(), 'nest-auth-password-reset-'),
  );
  const port = await availablePort();
  const processOptions = { windowsHide: true, timeout: 150_000 };

  try {
    await runPostgresTool(
      'initdb',
      [
        '-D',
        directory,
        '--username=postgres',
        '--auth=trust',
        '--encoding=UTF8',
        '--locale=C',
        '--no-sync',
      ],
      processOptions,
    );
    await startPostgresServer(directory, port);
  } catch (setupError) {
    try {
      await stopPostgres(directory);
    } catch (cleanupError) {
      throw new AggregateError(
        [setupError, cleanupError],
        'Test cluster setup and cleanup failed',
      );
    }
    throw setupError;
  }

  return {
    directory,
    connection: {
      host: '127.0.0.1',
      port,
      username: 'postgres',
      database: 'postgres',
    },
  };
}

function startPostgresServer(directory, port) {
  return new Promise((resolve, reject) => {
    // PostgreSQL's background process can inherit pipes on Windows and delay execFile completion.
    const controller = spawn(
      'pg_ctl',
      [
        '-D',
        directory,
        '-l',
        path.join(directory, 'server.log'),
        '-o',
        `-h 127.0.0.1 -p ${port} -F`,
        '-w',
        '-t',
        '30',
        'start',
      ],
      { windowsHide: true, stdio: 'ignore', timeout: 45_000 },
    );
    controller.once('error', reject);
    controller.once('exit', (exitCode, signal) => {
      if (exitCode === 0) resolve();
      else
        reject(
          new Error(
            `PostgreSQL startup failed: exit=${exitCode}, signal=${signal}`,
          ),
        );
    });
  });
}

function testClusterDirectory(directory) {
  const resolvedDirectory = path.resolve(directory);
  if (
    path.dirname(resolvedDirectory) !== path.resolve(tmpdir()) ||
    !path.basename(resolvedDirectory).startsWith('nest-auth-password-reset-')
  ) {
    throw new Error(
      'Refusing to remove a directory outside the disposable test cluster',
    );
  }

  return resolvedDirectory;
}

async function stopPostgres(directory) {
  const resolvedDirectory = testClusterDirectory(directory);
  try {
    await runPostgresTool(
      'pg_ctl',
      ['-D', resolvedDirectory, '-m', 'fast', '-w', '-t', '30', 'stop'],
      { windowsHide: true, timeout: 60_000 },
    );
  } catch (stopError) {
    const status = await runPostgresTool(
      'pg_ctl',
      ['-D', resolvedDirectory, 'status'],
      {
        windowsHide: true,
        timeout: 10_000,
      },
    ).catch((statusError) => {
      if (statusError.code !== 3 && statusError.code !== 4) throw statusError;
      return null;
    });
    if (status !== null) throw stopError;
  }
  await rm(resolvedDirectory, { recursive: true, force: true });
}

module.exports = { startPostgres, stopPostgres };
