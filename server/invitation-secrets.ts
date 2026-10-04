import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';

function configuredSecret(): string {
  const configured = process.env.INVITATION_ENCRYPTION_KEY;
  if (!configured && process.env.NODE_ENV === 'production') {
    throw new Error('INVITATION_ENCRYPTION_KEY is required in production');
  }
  return configured ?? 'override-local-invitation-key-do-not-deploy';
}

function encryptionKey(): Buffer {
  return createHash('sha256').update('override-invitation-encryption-v1\0').update(configuredSecret()).digest();
}

export function invitationTokenHash(value: string): string {
  const key = createHash('sha256').update('override-invitation-lookup-v1\0').update(configuredSecret()).digest();
  return createHmac('sha256', key).update(value).digest('hex');
}

export function sessionTokenId(value: string): string {
  const key = createHash('sha256').update('override-session-lookup-v1\0').update(configuredSecret()).digest();
  return createHmac('sha256', key).update(value).digest('hex');
}

export function protectInvitationSecret(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `enc:v1:${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${ciphertext.toString('base64url')}`;
}

export function revealInvitationSecret(value: string): string {
  if (!value.startsWith('enc:v1:')) return value;
  const [, , ivText, tagText, ciphertextText] = value.split(':');
  if (!ivText || !tagText || !ciphertextText) throw new Error('Invalid encrypted invitation secret');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivText, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextText, 'base64url')), decipher.final()]).toString('utf8');
}
