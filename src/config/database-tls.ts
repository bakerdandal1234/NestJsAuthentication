import { X509Certificate } from 'node:crypto';
import type { TlsOptions } from 'node:tls';

export function databaseTlsOptions(environment: NodeJS.ProcessEnv): TlsOptions | false {
  if (environment.NODE_ENV !== undefined && !['development', 'test', 'production'].includes(environment.NODE_ENV)) {
    throw new Error('NODE_ENV must be development, test or production');
  }
  const ca = environment.DB_SSL_CA?.trim();
  if (ca) validateDatabaseCa(ca);
  if (environment.NODE_ENV !== 'production') return false;
  return { rejectUnauthorized: true, ...(ca ? { ca } : {}) };
}

function validateDatabaseCa(certificate: string): void {
  try {
    new X509Certificate(certificate);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    throw new Error('DB_SSL_CA must contain a valid PEM certificate', { cause: error });
  }
}
