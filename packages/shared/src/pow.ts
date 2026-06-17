export interface PowResult {
  nonce: string;
  iterations: number;
}

function countLeadingZeroBits(buf: Uint8Array): number {
  let bits = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0) {
      bits += 8;
    } else {
      let mask = 0x80;
      while (mask > 0 && (buf[i]! & mask) === 0) {
        bits++;
        mask >>= 1;
      }
      break;
    }
  }
  return bits;
}

async function sha256(message: string): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const data = encoder.encode(message);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return new Uint8Array(hash);
}

export async function solvePoW(
  challenge: string,
  difficulty: number,
  onProgress?: (iterations: number) => void,
): Promise<PowResult> {
  let iterations = 0;
  const startTime = Date.now();

  while (true) {
    const buf = new Uint8Array(8);
    crypto.getRandomValues(buf);
    const nonce =
      Date.now().toString(36) +
      Array.from(buf)
        .map((b) => b.toString(36))
        .join('') +
      iterations.toString(36);
    const hash = await sha256(challenge + nonce);
    iterations++;

    if (countLeadingZeroBits(hash) >= difficulty) {
      return { nonce, iterations };
    }

    if (iterations % 1000 === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (onProgress) onProgress(iterations);
    }

    if (iterations % 10000 === 0 && Date.now() - startTime > 60000) {
      throw new Error('PoW timed out after 60 seconds');
    }
  }
}

export function solvePoWSync(
  challenge: string,
  difficulty: number,
  onProgress?: (iterations: number) => void,
): PowResult {
  const startTime = Date.now();
  const MAX_DURATION_MS = 120_000;
  let iterations = 0;
  while (true) {
    const buf = new Uint8Array(8);
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      crypto.getRandomValues(buf);
    } else {
      for (let i = 0; i < 8; i++) buf[i] = Math.floor(Math.random() * 256);
    }
    const nonce =
      Date.now().toString(36) +
      Array.from(buf)
        .map((b) => b.toString(36))
        .join('') +
      iterations.toString(36);
    const hash = sha256Digest(challenge + nonce);
    iterations++;
    if (countLeadingZeroBits(hash) >= difficulty) {
      return { nonce, iterations };
    }
    if (iterations % 10000 === 0 && Date.now() - startTime > MAX_DURATION_MS) {
      throw new Error('PoW timed out after 120 seconds');
    }
    if (iterations % 1000 === 0 && onProgress) {
      onProgress(iterations);
    }
  }
}

function sha256Digest(message: string): Uint8Array {
  const n = message.length;
  const bytes = new Uint8Array(n * 3);
  let j = 0;
  for (let i = 0; i < n; i++) {
    const c = message.charCodeAt(i);
    if (c < 0x80) {
      bytes[j++] = c;
    } else if (c < 0x800) {
      bytes[j++] = 0xc0 | (c >> 6);
      bytes[j++] = 0x80 | (c & 0x3f);
    } else {
      bytes[j++] = 0xe0 | (c >> 12);
      bytes[j++] = 0x80 | ((c >> 6) & 0x3f);
      bytes[j++] = 0x80 | (c & 0x3f);
    }
  }
  return sha256DigestBytes(bytes.subarray(0, j));
}

function sha256DigestBytes(input: Uint8Array): Uint8Array {
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);

  const ml = input.length * 8;
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(input);
  padded[input.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 4, ml, false);

  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const W = new Uint32Array(64);
  const temp = new Uint32Array(8);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i++) {
      W[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i++) {
      const w15 = W[i - 15]!;
      const w2 = W[i - 2]!;
      const s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3);
      const s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
      W[i] = (W[i - 16]! + s0 + W[i - 7]! + s1) | 0;
    }

    temp.set(H);

    for (let i = 0; i < 64; i++) {
      const t4 = temp[4]!;
      const t5 = temp[5]!;
      const t6 = temp[6]!;
      const t7 = temp[7]!;
      const t0 = temp[0]!;
      const t1 = temp[1]!;
      const t2_ = temp[2]!;
      const t3 = temp[3]!;
      const S1 = ((t4 >>> 6) | (t4 << 26)) ^ ((t4 >>> 11) | (t4 << 21)) ^ ((t4 >>> 25) | (t4 << 7));
      const ch = (t4 & t5) ^ (~t4 & t6);
      const t1sum = (t7 + S1 + ch + K[i]! + W[i]!) | 0;
      const S0 = ((t0 >>> 2) | (t0 << 30)) ^ ((t0 >>> 13) | (t0 << 19)) ^ ((t0 >>> 22) | (t0 << 10));
      const maj = (t0 & t1) ^ (t0 & t2_) ^ (t1 & t2_);
      const t2sum = (S0 + maj) | 0;

      temp[7] = t6;
      temp[6] = t5;
      temp[5] = t4;
      temp[4] = (t3 + t1sum) | 0;
      temp[3] = t2_;
      temp[2] = t1;
      temp[1] = t0;
      temp[0] = (t1sum + t2sum) | 0;
    }

    for (let i = 0; i < 8; i++) {
      H[i] = (H[i]! + temp[i]!) | 0;
    }
  }

  const result = new Uint8Array(32);
  const resultView = new DataView(result.buffer);
  for (let i = 0; i < 8; i++) {
    resultView.setUint32(i * 4, H[i]!, false);
  }
  return result;
}
