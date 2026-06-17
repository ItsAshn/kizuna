import { describe, it, expect } from 'vitest';
import {
  generateKeyPair,
  encryptDM,
  decryptDM,
  isEncryptedContent,
  type EncryptedMessage,
} from './crypto';

describe('crypto', () => {
  describe('generateKeyPair', () => {
    it('generates a key pair with valid public and secret keys', () => {
      const kp = generateKeyPair();
      expect(kp.publicKey).toBeInstanceOf(Uint8Array);
      expect(kp.secretKey).toBeInstanceOf(Uint8Array);
      expect(kp.publicKey.length).toBe(32);
      expect(kp.secretKey.length).toBe(32);
      expect(typeof kp.publicKeyString).toBe('string');
    });

    it('generates unique key pairs each time', () => {
      const kp1 = generateKeyPair();
      const kp2 = generateKeyPair();
      expect(kp1.publicKeyString).not.toBe(kp2.publicKeyString);
    });
  });

  describe('encryptDM / decryptDM', () => {
    it('encrypts and decrypts a message correctly', () => {
      const alice = generateKeyPair();
      const bob = generateKeyPair();

      const plaintext = 'Hello, Bob!';
      const encrypted = encryptDM(plaintext, bob.publicKeyString, alice.secretKey);

      expect(encrypted.v).toBe(1);
      expect(typeof encrypted.ct).toBe('string');
      expect(typeof encrypted.n).toBe('string');

      const decrypted = decryptDM(encrypted, alice.publicKeyString, bob.secretKey);
      expect(decrypted).toBe(plaintext);
    });

    it('fails to decrypt with wrong key', () => {
      const alice = generateKeyPair();
      const bob = generateKeyPair();
      const eve = generateKeyPair();

      const encrypted = encryptDM('secret', bob.publicKeyString, alice.secretKey);

      expect(() => decryptDM(encrypted, alice.publicKeyString, eve.secretKey)).toThrow();
    });

    it('throws on encryption failure with invalid public key', () => {
      const alice = generateKeyPair();
      expect(() => encryptDM('test', 'invalid-base64', alice.secretKey)).toThrow();
    });
  });

  describe('isEncryptedContent', () => {
    it('identifies encrypted content', () => {
      const encrypted: EncryptedMessage = { v: 1, ct: 'abc', n: 'def' };
      const result = isEncryptedContent(JSON.stringify(encrypted));
      expect(result).toEqual(encrypted);
    });

    it('returns null for plain text', () => {
      expect(isEncryptedContent('hello world')).toBeNull();
    });

    it('returns null for invalid JSON', () => {
      expect(isEncryptedContent('not json')).toBeNull();
    });
  });
});
