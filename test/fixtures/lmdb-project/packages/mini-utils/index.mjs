import crypto from 'node:crypto';

export function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}
