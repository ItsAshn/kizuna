import { describe, it, expect } from 'vitest';
import nacl from 'tweetnacl';
import { encodeBase64 } from 'tweetnacl-util';
import {
  encryptDM,
  decryptDM,
  isEncryptedContent,
  type EncryptedMessage,
} from './crypto';

function generateTestKeyPair(): { publicKey: Uint8Array; secretKey: Uint8Array; publicKeyString: string } {
  const kp = nacl.box.keyPair();
  return {
    publicKey: kp.publicKey,
    secretKey: kp.secretKey,
    publicKeyString: encodeBase64(kp.publicKey),
  };
}

describe('crypto', () => {
  describe('encryptDM / decryptDM', () => {
    it('encrypts and decrypts a message correctly', () => {
      const alice = generateTestKeyPair();
      const bob = generateTestKeyPair();

      const plaintext = 'Hello, Bob!';
      const encrypted = encryptDM(plaintext, bob.publicKeyString, alice.secretKey);

      expect(encrypted.v).toBe(1);
      expect(typeof encrypted.ct).toBe('string');
      expect(typeof encrypted.n).toBe('string');

      const decrypted = decryptDM(encrypted, alice.publicKeyString, bob.secretKey);
      expect(decrypted).toBe(plaintext);
    });

    it('fails to decrypt with wrong key', () => {
      const alice = generateTestKeyPair();
      const bob = generateTestKeyPair();
      const eve = generateTestKeyPair();

      const encrypted = encryptDM('secret', bob.publicKeyString, alice.secretKey);

      expect(() => decryptDM(encrypted, alice.publicKeyString, eve.secretKey)).toThrow();
    });

    it('throws on encryption failure with invalid public key', () => {
      const alice = generateTestKeyPair();
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
