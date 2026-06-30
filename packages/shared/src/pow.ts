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
): Promise<{ nonce: string; iterations: number }> {
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
