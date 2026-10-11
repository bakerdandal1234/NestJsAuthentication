export function decodeTwoFactorKey(encodedKey: string): Buffer {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(encodedKey)) {
    throw new Error('STAFF_2FA_ENCRYPTION_KEY must be exactly 32 bytes encoded as canonical Base64');
  }
  const encryptionKey = Buffer.from(encodedKey, 'base64');
  if (encryptionKey.toString('base64') !== encodedKey) {
    throw new Error('STAFF_2FA_ENCRYPTION_KEY must use canonical Base64');
  }
  return encryptionKey;
}
