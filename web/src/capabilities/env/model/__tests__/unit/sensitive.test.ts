import { describe, it, expect } from 'vitest';
import { MASKED_VALUE, isSensitiveKey } from '@/capabilities/env/model/sensitive';

describe('isSensitiveKey', () => {
  it('matches every sensitive family, case-insensitively', () => {
    const keys = [
      'API_KEY',
      'ACCESS_TOKEN',
      'AWS_SECRET_ACCESS_KEY',
      'DB_PASSWORD',
      'OAUTH_CLIENT_SECRET',
      'AUTH_TOKEN',
      'STRIPE_SECRET_KEY',
      'PRIVATE_CREDENTIALS',
      'api_key',
      'my_password',
    ];
    for (const key of keys) {
      expect(isSensitiveKey(key), key).toBe(true);
    }
  });

  it('does not match ordinary variable names', () => {
    const keys = ['NODE_ENV', 'PORT', 'DATABASE_URL', 'LOG_LEVEL', 'REGION', ''];
    for (const key of keys) {
      expect(isSensitiveKey(key), key).toBe(false);
    }
  });

  it('matches a family anywhere in the name, not only as a suffix', () => {
    expect(isSensitiveKey('KEYSTORE_PATH')).toBe(true);
    expect(isSensitiveKey('MY_TOKENIZER')).toBe(true);
  });
});

describe('MASKED_VALUE', () => {
  it('is a fixed length so the mask never leaks the value length', () => {
    expect(MASKED_VALUE).toBe('••••••••');
  });
});
