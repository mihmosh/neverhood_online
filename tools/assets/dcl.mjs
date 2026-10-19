/*
 * Altered JavaScript implementation based on blast 1.3 format/tables.
 * https://github.com/madler/zlib/tree/master/contrib/blast
 * Copyright (C) 2003, 2012, 2013 Mark Adler
 *
 * This software is provided 'as-is', without any express or implied
 * warranty.  In no event will the author be held liable for any damages
 * arising from the use of this software.
 *
 * Permission is granted to anyone to use this software for any purpose,
 * including commercial applications, and to alter it and redistribute it
 * freely, subject to the following restrictions:
 *
 * 1. The origin of this software must not be misrepresented; you must not
 *    claim that you wrote the original software. If you use this software
 *    in a product, an acknowledgment in the product documentation would be
 *    appreciated but is not required.
 * 2. Altered source versions must be plainly marked as such, and must not be
 *    misrepresented as being the original software.
 * 3. This notice may not be removed or altered from any source distribution.
 *
 * Mark Adler    madler@alumni.caltech.edu
 */
function table(repeats) {
  const lengths = repeats.flatMap(n => Array((n >> 4) + 1).fill(n & 15));
  const counts = Array(14).fill(0);
  for (const n of lengths) counts[n]++;
  const symbols = lengths.map((length, symbol) => ({ length, symbol }))
    .sort((a, b) => a.length - b.length || a.symbol - b.symbol).map(x => x.symbol);
  return { counts, symbols };
}
const literals = table([11,124,8,7,28,7,188,13,76,4,10,8,12,10,12,10,8,23,8,9,7,6,7,8,7,6,55,8,23,24,12,11,7,9,11,12,6,7,22,5,7,24,6,11,9,6,7,22,7,11,38,7,9,8,25,11,8,11,9,12,8,12,5,38,5,38,5,11,7,5,6,21,6,10,53,8,7,24,10,27,44,253,253,253,252,252,252,13,12,45,12,45,12,61,12,45,44,173]);
const lengths = table([2,35,36,53,38,23]);
const distances = table([2,20,53,230,247,151,248]);
const bases = [3,2,4,5,6,7,8,9,10,12,16,24,40,72,136,264];
const extras = [0,0,0,0,0,0,0,0,1,2,3,4,5,6,7,8];

export function explode(input, expectedSize, limit = 64 * 1024 * 1024) {
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0 || expectedSize > limit)
    throw new Error('DCL output exceeds configured limit');
  let position = 0, bitBuffer = 0, bitCount = 0, written = 0;
  function bits(n) {
    while (bitCount < n) {
      if (position >= input.length) throw new Error('Truncated DCL stream');
      bitBuffer |= input[position++] << bitCount;
      bitCount += 8;
    }
    const value = bitBuffer & ((1 << n) - 1);
    bitBuffer >>>= n;
    bitCount -= n;
    return value;
  }
  function decode(t) {
    let code = 0, first = 0, index = 0;
    for (let length = 1; length <= 13; length++) {
      code |= bits(1) ^ 1;
      const count = t.counts[length];
      if (code < first + count) return t.symbols[index + code - first];
      index += count;
      first = (first + count) << 1;
      code <<= 1;
    }
    throw new Error('Invalid DCL Huffman code');
  }
  const coded = bits(8), dictionary = bits(8);
  if (coded > 1 || dictionary < 4 || dictionary > 6) throw new Error('Invalid DCL header');
  const out = Buffer.alloc(expectedSize);
  for (;;) {
    if (!bits(1)) {
      const literal = coded ? decode(literals) : bits(8);
      if (written >= out.length) throw new Error('DCL output overflow');
      out[written++] = literal;
    } else {
      const symbol = decode(lengths);
      const length = bases[symbol] + bits(extras[symbol]);
      if (length === 519) break;
      const n = length === 2 ? 2 : dictionary;
      const distance = (decode(distances) << n) + bits(n) + 1;
      if (distance > written) throw new Error('Invalid DCL backward distance');
      if (written + length > out.length) throw new Error('DCL output overflow');
      for (let i = 0; i < length; i++, written++) out[written] = out[written - distance];
    }
  }
  if (written !== expectedSize) throw new Error(`DCL size mismatch: ${written} != ${expectedSize}`);
  return out;
}
