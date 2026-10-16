/* QTC Airgap Desk — offline-signing protocol core (pure logic, no DOM).
 *
 * The airgap protocol moves two artifacts between an online ("hot") machine
 * and an offline ("cold") machine that holds the keys:
 *
 *   1. CHAIN TICKET  (hot -> cold):  the chain facts a cold signer needs to
 *      build a byte-exact unsigned payload — genesis hash, spec/tx versions,
 *      head number+hash, the sender's next nonce, and the mortal-era window
 *      the signature will bind to. Small (~300 bytes): one QR.
 *
 *   2. SIGNED PACKAGE (cold -> hot): the complete signed extrinsic. ML-DSA
 *      signatures are kilobytes (ML-DSA-65: 3309 B sig + 1952 B pubkey), so the
 *      package is transported as a numbered chunk sequence
 *      `QAGX:<session>:<i>/<n>:<base64url>` — chunked QRs, pasted text blocks,
 *      or a single file.
 *
 * The hot side never signs. Before broadcasting, it decodes the extrinsic,
 * re-derives the exact signing payload from the ticket it issued, and
 * verifies the ML-DSA signature locally under the chain's QUANTUS_EXTRINSIC
 * context. A signature that verifies here is byte-identical to what the
 * web wallet would submit — a tampered package fails loudly instead.
 *
 * Wire formats (this file) are covered by tests/run-tests.mjs.
 */
import {
  ss58Encode, ss58Decode, hexEncode, hexDecode, QUANTUS_SS58_PREFIX,
} from './lib/quantus-crypto.js';
import {
  compactDecode, buildSigningPayload, buildTransferCall, buildBatchAllCall, buildExtrinsic, SIGNING_CONTEXT,
  BALANCES_PALLET_INDEX, TRANSFER_KEEP_ALIVE_CALL_INDEX,
  UTILITY_PALLET_INDEX, BATCH_ALL_CALL_INDEX,
  DILITHIUM65_VARIANT, DILITHIUM87_VARIANT, EXTRINSIC_VERSION,
  plancksToQtc,
} from './lib/scale.js';

/* ---------------- optional builder service fee ----------------
 * PROFIT route (fleet pattern, added 2026-10-12): the cold desk may add a
 * small, plainly disclosed service fee ON TOP of the amount — the
 * recipient's amount is NEVER reduced. The fee is a second
 * Balances::transfer_keep_alive to the builder's QTC address
 * (SERVICE_FEE_ADDRESS, the same address in this page's footer), wrapped
 * with the recipient transfer in ONE atomic Utility.batch_all (recipient
 * leg FIRST, fee leg LAST), so the sender pays both legs or neither and
 * still signs exactly ONE extrinsic. Exact BigInt math:
 * fee = floor(amount * bps / 10,000), capped at 100 bps in code, so it
 * never exceeds the quoted percentage; a fee that floors to zero plancks
 * adds NO leg (a 0-planck transfer is invalid) and the package stays a
 * plain transfer, byte-identical to before. */
export const SERVICE_FEE_ADDRESS = 'qznY8nwuvWcCCVys4da1oQdysyh8YUZYRjRqgk3S8Wos8kbau';
export const SERVICE_FEE_MAX_BPS = 100;

let _serviceFeeAccountId = null;
/* The fee leg's 32-byte account id, derived from the disclosed address
 * with this file's own SS58 codec so the leg can never drift from the
 * address the UI names. */
export function serviceFeeAccountId() {
  if (!_serviceFeeAccountId) {
    const { prefix, accountId } = ss58Decode(SERVICE_FEE_ADDRESS);
    if (prefix !== QUANTUS_SS58_PREFIX) throw new Error('service fee address has wrong network prefix');
    _serviceFeeAccountId = accountId;
  }
  return _serviceFeeAccountId;
}

export function computeServiceFee(amountPlancks, feeBps) {
  const amount = BigInt(amountPlancks);
  let bps = Number(feeBps);
  if (!isFinite(bps) || bps < 0) bps = 0;
  if (bps > SERVICE_FEE_MAX_BPS) bps = SERVICE_FEE_MAX_BPS;
  bps = Math.floor(bps);
  if (amount <= 0n || bps === 0) return { feePlancks: 0n, feeBps: bps };
  return { feePlancks: (amount * BigInt(bps)) / 10000n, feeBps: bps };
}

export function feeBpsLabel(bps) {
  const b = Math.floor(Number(bps) || 0);
  const whole = Math.floor(b / 100), rem = b % 100;
  if (rem === 0) return whole + '%';
  const frac = String(rem).padStart(2, '0').replace(/0+$/, '');
  return whole + '.' + frac + '%';
}

/* The call the cold side signs: plain transfer when no fee applies, else
 * one atomic batch_all of [recipient leg untouched and FIRST, fee leg]. */
export function buildColdCall({ destAccountId, amountPlancks, serviceFeePlancks = 0n }) {
  const recipient = buildTransferCall(destAccountId, amountPlancks);
  const fee = BigInt(serviceFeePlancks);
  if (fee <= 0n) return recipient;
  return buildBatchAllCall([recipient, buildTransferCall(serviceFeeAccountId(), fee)]);
}

export const TICKET_MAGIC = 'QAGT1';
export const CHUNK_MAGIC = 'QAGX';
export const TICKET_VERSION = 1;
export const QUANTUS_PREFIX = QUANTUS_SS58_PREFIX;
export const DEFAULT_ERA_PERIOD = 64;

/* ---------------- base64url ---------------- */
const B64C = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function b64urlEncode(bytes) {
  let bits = 0, acc = 0, out = '';
  for (const b of bytes) {
    acc = (acc << 8) | b; bits += 8;
    while (bits >= 6) { bits -= 6; out += B64C[(acc >> bits) & 63]; }
  }
  if (bits > 0) out += B64C[(acc << (6 - bits)) & 63];
  return out;
}

export function b64urlDecode(str) {
  const s = String(str).trim();
  if (!/^[A-Za-z0-9\-_]*$/.test(s)) throw new Error('chunk: invalid base64url characters');
  const out = [];
  let bits = 0, acc = 0;
  for (const ch of s) {
    acc = (acc << 6) | B64C.indexOf(ch); bits += 6;
    if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xff); }
  }
  return new Uint8Array(out);
}

const te = new TextEncoder();
const td = new TextDecoder();

/* ---------------- chain ticket ---------------- */

/* Build the ticket object the hot side issues. Fields:
 * { addr, nonce, genesis (0x hex), spec, txv, head, headHash (0x),
 *   era: { period, phase, birth, birthHash (0x) }, fee (plancks string|null),
 *   issued (ISO) } */
export function makeTicket(f) {
  return {
    t: 'qtc-ticket', v: TICKET_VERSION,
    addr: f.addr, nonce: f.nonce,
    genesis: f.genesis, spec: f.spec, txv: f.txv,
    head: f.head, headHash: f.headHash,
    era: { period: f.era.period, phase: f.era.phase, birth: f.era.birth, birthHash: f.era.birthHash },
    fee: f.fee ?? null,
    issued: f.issued || new Date().toISOString(),
  };
}

function mustHex32(h, what) {
  const b = hexDecode(String(h || ''));
  if (b.length !== 32) throw new Error(`ticket: ${what} must be 32 bytes hex`);
  return b;
}

/* Serialize a ticket to its transport string: `QAGT1:<base64url(json)>`. */
export function encodeTicket(ticket) {
  return `${TICKET_MAGIC}:${b64urlEncode(te.encode(JSON.stringify(ticket)))}`;
}

/* Parse + strictly validate a ticket transport string. Throws on anything
 * malformed — the cold side refuses to sign against a bad ticket. */
export function decodeTicket(str) {
  const s = String(str || '').trim();
  const m = s.match(/^QAGT1:([A-Za-z0-9\-_]+)$/);
  if (!m) throw new Error('not a QTC chain ticket (expected QAGT1:…)');
  let obj;
  try { obj = JSON.parse(td.decode(b64urlDecode(m[1]))); }
  catch { throw new Error('ticket: payload is not valid JSON'); }
  if (obj.t !== 'qtc-ticket') throw new Error('ticket: wrong type tag');
  if (obj.v !== TICKET_VERSION) throw new Error(`ticket: unsupported version ${obj.v}`);
  // sender address: checksum + Quantus prefix enforced
  const { prefix, accountId } = ss58Decode(String(obj.addr || ''));
  if (prefix !== QUANTUS_PREFIX) throw new Error(`ticket: wrong network prefix ${prefix} (need 189)`);
  if (!Number.isInteger(obj.nonce) || obj.nonce < 0) throw new Error('ticket: nonce must be a non-negative integer');
  // The nonce is a u32 on chain (system_accountNextIndex — the issuer's
  // own parseNonce bounds it to u32 before a ticket exists), and it is
  // compact-encoded into the signing payload. A value >= 2^32 can never
  // be the account's next index, and a non-safe integer (>= 2^53) does
  // not even survive JSON.parse intact — the ticket text and the value
  // the cold side signs would silently disagree. Same class as the
  // spec/txv u32 bound below; it was the one ticket integer missing it.
  if (!Number.isSafeInteger(obj.nonce) || obj.nonce > 0xFFFFFFFF)
    throw new Error('ticket: nonce must fit u32 (<= 4294967295)');
  mustHex32(obj.genesis, 'genesis');
  mustHex32(obj.headHash, 'headHash');
  mustHex32(obj.era && obj.era.birthHash, 'era.birthHash');
  for (const k of ['spec', 'txv', 'head']) {
    if (!Number.isInteger(obj[k]) || obj[k] < 0) throw new Error(`ticket: ${k} must be a non-negative integer`);
  }
  // spec/tx versions are serialized u32le into the signing payload
  // (scale.js buildSigningPayload) — a value >= 2^32 would wrap silently
  // and the cold side would sign a payload naming version 0.
  for (const k of ['spec', 'txv']) {
    if (obj[k] > 0xFFFFFFFF) throw new Error(`ticket: ${k} must fit u32 (<= 4294967295)`);
  }
  // Fleet chain-height bound (validChainHeight): no genuine ticket head
  // can sit above it; an absurd head would anchor era reasoning to a
  // block that cannot exist.
  if (obj.head > 10000000) throw new Error('ticket: head is above the fleet chain-height bound (10000000)');
  for (const k of ['period', 'phase', 'birth']) {
    if (!Number.isInteger(obj.era[k]) || obj.era[k] < 0) throw new Error(`ticket: era.${k} must be a non-negative integer`);
  }
  /* Era RELATIONS (round 2): the fields above are shapes; the era is one
   * claim about a window, and its parts must agree the way the SCALE
   * mortal-era codec (scale.js encodeMortalEra / decodeMortalEra here)
   * can actually encode it, and the way eraBirth() derives it:
   *   period = 2 << (encoded % 16) — a power of two in [4, 65536];
   *   phase is stored divided by the quantize step, so it must be a
   *   multiple of it, and must sit below period;
   *   birth ≡ phase (mod period) and the window [birth, birth+period)
   *   must contain the ticket head — a birth after head, or a window that
   *   already closed at head, describes an era the runtime would decode
   *   differently from the one this ticket claims to bind. */
  {
    const { period, phase, birth } = obj.era;
    if (period < 4 || period > 65536 || (period & (period - 1)) !== 0)
      throw new Error('ticket: era.period must be a power of two in 4..65536 (SCALE mortal era)');
    if (phase >= period) throw new Error('ticket: era.phase must be below era.period');
    const quantize = Math.max(1, Math.floor(period / 4096));
    if (phase % quantize !== 0)
      throw new Error('ticket: era.phase must be a multiple of the era quantize step');
    if (birth % period !== phase)
      throw new Error('ticket: era.birth must be congruent to era.phase mod era.period');
    if (birth > obj.head) throw new Error('ticket: era.birth is after the ticket head');
    if (obj.head >= birth + period)
      throw new Error('ticket: era window already expired at the ticket head');
  }
  if (obj.fee !== null && obj.fee !== undefined && !/^\d+$/.test(String(obj.fee)))
    throw new Error('ticket: fee must be a plancks integer string');
  return { ...obj, senderAccountId: accountId };
}

/* ---------------- chunk transport ---------------- */

/* Split a 0x-hex payload into numbered chunk strings. chunkBytes = raw bytes
 * per chunk (default 900 → a chunk QR holds ~1200 base64url chars). */
export function encodeChunks(sessionId, hexPayload, chunkBytes = 900) {
  if (!/^[0-9a-fA-F]{1,8}$/.test(sessionId)) throw new Error('session id must be 1–8 hex chars');
  const raw = hexDecode(String(hexPayload).replace(/^0x/, ''));
  const n = Math.max(1, Math.ceil(raw.length / chunkBytes));
  const out = [];
  for (let i = 0; i < n; i++) {
    const slice = raw.slice(i * chunkBytes, (i + 1) * chunkBytes);
    out.push(`${CHUNK_MAGIC}:${sessionId}:${i + 1}/${n}:${b64urlEncode(slice)}`);
  }
  return out;
}

const CHUNK_RE = /^QAGX:([0-9a-fA-F]{1,8}):(\d+)\/(\d+):([A-Za-z0-9\-_]+)$/;

/* A signed package is ~7.5 KB worst case (ML-DSA-87); even at a tiny
 * 100-byte chunk size that is under 100 chunks. This bound exists so a
 * hostile count (1/999999999) is refused instantly instead of grinding
 * the missing-chunk list construction. */
export const MAX_CHUNKS = 10000;

/* Reassemble chunk strings (any order, IDENTICAL duplicates tolerated)
 * into 0x hex. Throws on mixed sessions, missing chunks, or malformed
 * lines. Round 2 (relations): a duplicate carrying DIFFERENT bytes for
 * the same index is a conflict, not a spare copy — first-copy-wins would
 * silently assemble whichever package was pasted first; and every
 * non-final chunk of a session carries the same byte count (the encoder
 * slices uniformly), so a short middle chunk means the reassembled
 * bytes shift — refuse it instead of assembling a different payload. */
export function decodeChunks(lines) {
  const arr = (Array.isArray(lines) ? lines : String(lines).split(/\s+/))
    .map((l) => l.trim()).filter(Boolean);
  if (!arr.length) throw new Error('no chunks provided');
  let sid = null, n = null;
  const slots = new Map();
  for (const line of arr) {
    const m = line.match(CHUNK_RE);
    if (!m) throw new Error('malformed chunk line: ' + line.slice(0, 40));
    const [, s, iStr, nStr, body] = m;
    const i = Number(iStr), nn = Number(nStr);
    if (sid === null) { sid = s; n = nn; }
    if (s !== sid) throw new Error('chunks from more than one session — keep sessions separate');
    if (nn !== n) throw new Error('inconsistent chunk counts in session ' + sid);
    if (nn > MAX_CHUNKS) throw new Error(`chunk count ${nn} exceeds the session bound (${MAX_CHUNKS})`);
    if (i < 1 || i > n) throw new Error(`chunk index ${i} out of range 1..${n}`);
    const bytes = b64urlDecode(body);
    if (bytes.length === 0) throw new Error(`chunk ${i}: empty body`);
    if (slots.has(i)) {
      const prev = slots.get(i);
      if (prev.length !== bytes.length || prev.some((b, j) => b !== bytes[j]))
        throw new Error(`chunk ${i}: conflicting duplicate (two different copies in one session)`);
    } else slots.set(i, bytes);
  }
  if (slots.size !== n) {
    const missing = [];
    for (let i = 1; i <= n; i++) if (!slots.has(i)) missing.push(i);
    throw new Error(`missing chunk(s): ${missing.join(', ')} of ${n}`);
  }
  if (n > 1) {
    const size = slots.get(1).length;
    for (let i = 2; i < n; i++) {
      if (slots.get(i).length !== size)
        throw new Error(`chunk ${i}: ${slots.get(i).length} bytes, expected the session chunk size ${size} — reassembly would shift the payload`);
    }
    if (slots.get(n).length > size)
      throw new Error(`chunk ${n}: final chunk longer than the session chunk size ${size}`);
  }
  const total = [...slots.values()].reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (let i = 1; i <= n; i++) { out.set(slots.get(i), o); o += slots.get(i).length; }
  return { sessionId: sid, hex: '0x' + hexEncode(out) };
}

/* ---------------- package-line merge ----------------
 * The hot desk assembles a signed package from chunk texts collected via
 * QR/file PLUS whatever is in the paste box, deduped first-wins (collected
 * order first). The merge used to test each pasted token with
 * Array.includes over the growing merged list — O(n^2) in pasted tokens,
 * run synchronously on the "Assemble & verify" click: the paste box
 * accepts arbitrary text, and 20k unique tokens froze the air-gapped
 * machine for ~17s (40k for ~2 minutes) in Node timings. A Set keeps the
 * exact same result in linear time. Non-iterable inputs fail soft to an
 * empty list; inputs are never mutated. The dedupe itself is load-
 * bearing, not cosmetic: the assembler accepts a lone 0x… extrinsic only
 * when exactly ONE distinct line remains, so pasting the same line
 * twice must still assemble. */
export function mergePackageLines(collected, pasted) {
  const out = [];
  const seen = new Set();
  for (const part of [collected, pasted]) {
    if (!part || typeof part[Symbol.iterator] !== 'function') continue;
    for (const s of part) {
      if (seen.has(s)) continue;
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

/* ---------------- era decode (mirror of scale.js encodeMortalEra) -------- */

export function decodeMortalEra(twoBytes) {
  if (twoBytes.length < 2) throw new Error('era: need 2 bytes');
  const encoded = twoBytes[0] | (twoBytes[1] << 8);
  if (encoded === 0) return { immortal: true, period: 0, phase: 0 };
  const period = 2 << (encoded % 16);
  const quantize = Math.max(1, period >> 12);
  const phase = (encoded >> 4) * quantize;
  return { immortal: false, period, phase };
}

/* ---------------- signed-extrinsic decode ----------------
 * Parses a signed Quantus extrinsic and extracts everything the hot side
 * needs to re-verify: address, signature wire, era, nonce, tip, and the call.
 * Balances::transfer_keep_alive (pallet 2 / call 3) is decoded directly,
 * and a Utility::batch_all (pallet 9 / call 2) of EXACTLY two
 * transfer_keep_alive legs — the shape buildColdCall produces when the
 * optional service fee is on — is decoded leg-by-leg; anything else
 * throws an honest "unsupported call" error. */

export function decodeSignedExtrinsic(hex) {
  const raw = hexDecode(String(hex).replace(/^0x/, ''));
  const { value: bodyLen, next: o0 } = compactDecode(raw, 0);
  const body = raw.slice(o0);
  if (body.length !== Number(bodyLen)) throw new Error('extrinsic: length prefix mismatch');
  let o = 0;
  if (body[o++] !== EXTRINSIC_VERSION) throw new Error('extrinsic: not a signed v4 extrinsic (0x84)');
  if (body[o++] !== 0x00) throw new Error('extrinsic: only AccountId32 senders supported');
  const accountId = body.slice(o, o + 32); o += 32;
  const variant = body[o++];
  let scheme, sigLen, pubLen;
  if (variant === DILITHIUM65_VARIANT) { scheme = 65; sigLen = 3309; pubLen = 1952; }
  else if (variant === DILITHIUM87_VARIANT) { scheme = 87; sigLen = 4627; pubLen = 2592; }
  else throw new Error('extrinsic: unknown signature variant ' + variant);
  const signature = body.slice(o, o + sigLen); o += sigLen;
  const pubkey = body.slice(o, o + pubLen); o += pubLen;
  const era = decodeMortalEra(body.slice(o, o + 2)); o += 2;
  const n1 = compactDecode(body, o); const nonce = n1.value; o = n1.next;
  const n2 = compactDecode(body, o); const tip = n2.value; o = n2.next;
  const metaHashMode = body[o++];
  if (metaHashMode !== 0x00) throw new Error('extrinsic: metadata-hash mode not supported');
  const pallet = body[o++], callIdx = body[o++];
  /* Parse one Balances::transfer_keep_alive leg starting at offset p.
   * Returns { destAccountId, amountPlancks, next }. */
  const parseTransferLeg = (p) => {
    if (body[p] !== BALANCES_PALLET_INDEX || body[p + 1] !== TRANSFER_KEEP_ALIVE_CALL_INDEX)
      throw new Error(`extrinsic: unsupported inner call (pallet ${body[p]}, call ${body[p + 1]}) — batch legs must be Balances.transfer_keep_alive`);
    p += 2;
    if (body[p++] !== 0x00) throw new Error('extrinsic: only AccountId32 destinations supported');
    const destAccountId = body.slice(p, p + 32); p += 32;
    const nn = compactDecode(body, p);
    return { destAccountId, amountPlancks: nn.value, next: nn.next };
  };
  let call;
  if (pallet === BALANCES_PALLET_INDEX && callIdx === TRANSFER_KEEP_ALIVE_CALL_INDEX) {
    o -= 2; // parseTransferLeg re-reads the pallet/call bytes
    const leg = parseTransferLeg(o); o = leg.next;
    call = {
      pallet, callIndex: callIdx, batch: false,
      destAccountId: leg.destAccountId, destAddress: ss58Encode(leg.destAccountId, QUANTUS_PREFIX),
      amountPlancks: leg.amountPlancks,
      serviceFeePlancks: 0n, serviceFeeDestAddress: null,
      totalPlancks: leg.amountPlancks,
      legs: [{ destAccountId: leg.destAccountId, destAddress: ss58Encode(leg.destAccountId, QUANTUS_PREFIX), amountPlancks: leg.amountPlancks }],
    };
  } else if (pallet === UTILITY_PALLET_INDEX && callIdx === BATCH_ALL_CALL_INDEX) {
    /* The ONLY batch shape this desk decodes: exactly two
     * transfer_keep_alive legs — the recipient leg and one further
     * transfer (in packages this desk builds, the disclosed service-fee
     * leg; the hot side renders BOTH legs verbatim so the signer can see
     * exactly where every planck goes). Any other batch is refused. */
    const cnt = compactDecode(body, o); o = cnt.next;
    if (Number(cnt.value) !== 2)
      throw new Error(`extrinsic: unsupported batch of ${cnt.value} calls — only a 2-leg transfer batch is decoded`);
    const legs = [];
    for (let i = 0; i < 2; i++) {
      const leg = parseTransferLeg(o); o = leg.next;
      legs.push({ destAccountId: leg.destAccountId, destAddress: ss58Encode(leg.destAccountId, QUANTUS_PREFIX), amountPlancks: leg.amountPlancks });
    }
    call = {
      pallet, callIndex: callIdx, batch: true,
      destAccountId: legs[0].destAccountId, destAddress: legs[0].destAddress,
      amountPlancks: legs[0].amountPlancks,
      serviceFeePlancks: legs[1].amountPlancks, serviceFeeDestAddress: legs[1].destAddress,
      totalPlancks: legs[0].amountPlancks + legs[1].amountPlancks,
      legs,
    };
  } else {
    throw new Error(`extrinsic: unsupported call (pallet ${pallet}, call ${callIdx}) — only Balances.transfer_keep_alive and a 2-leg Utility.batch_all of transfers are decoded`);
  }
  if (o !== body.length) throw new Error('extrinsic: trailing bytes after call');
  return {
    accountId, address: ss58Encode(accountId, QUANTUS_PREFIX),
    variant, scheme, signature, pubkey,
    era, nonce, tip,
    call,
    rawBody: body,
  };
}

/* ---------------- cold-side signing ----------------
 * Build the exact signing payload the runtime will check, from the ticket
 * the cold side imported. era is re-encoded from the ticket's period/phase
 * so the payload matches the window the hot side advertised. */

export function buildColdPayload({ ticket, destAccountId, amountPlancks, era, nonce, tip = 0n, serviceFeePlancks = 0n }) {
  const call = buildColdCall({ destAccountId, amountPlancks, serviceFeePlancks });
  return buildSigningPayload({
    call,
    era,
    nonce: BigInt(nonce),
    tip: BigInt(tip),
    specVersion: ticket.spec,
    txVersion: ticket.txv,
    genesisHash: hexDecode(ticket.genesis.replace(/^0x/, '')),
    eraBirthHash: hexDecode(ticket.era.birthHash.replace(/^0x/, '')),
  });
}

/* Assemble the final signed extrinsic on the cold side.
 * signResult: { signature (Uint8Array), pubkey (Uint8Array) }; scheme: 65|87. */
export function buildColdExtrinsic({ ticket, senderAccountId, destAccountId, amountPlancks, era, nonce, tip = 0n, scheme, signResult, serviceFeePlancks = 0n }) {
  const payload = buildColdPayload({ ticket, destAccountId, amountPlancks, era, nonce, tip, serviceFeePlancks });
  const expectedPub = scheme === 87 ? 2592 : 1952;
  if (signResult.pubkey.length !== expectedPub) throw new Error('signer returned wrong pubkey length');
  const variant = scheme === 87 ? DILITHIUM87_VARIANT : DILITHIUM65_VARIANT;
  const sigWire = new Uint8Array(1 + signResult.signature.length + signResult.pubkey.length);
  sigWire[0] = variant;
  sigWire.set(signResult.signature, 1);
  sigWire.set(signResult.pubkey, 1 + signResult.signature.length);
  const call = buildColdCall({ destAccountId, amountPlancks, serviceFeePlancks });
  return { payload, extrinsicHex: '0x' + hexEncode(buildExtrinsic({ accountId: senderAccountId, signatureWire: sigWire, era, nonce: BigInt(nonce), tip: BigInt(tip), call })) };
}

/* ---------------- hot-side re-verification ----------------
 * Re-derive the signing payload from the ORIGINAL ticket (not from values
 * the cold side claims) and verify the ML-DSA signature locally.
 * mlDsa: { verify(sig, msg, pub, opts) } — the noble ml_dsa65/87 module. */

export function reverifySigned({ ticket, decoded, mlDsa }) {
  const eraBytes = decoded.eraBytes; // set by decode below; kept for exactness
  const payload = buildSigningPayload({
    call: decoded.rawCall,
    era: eraBytes,
    nonce: decoded.nonce,
    tip: decoded.tip,
    specVersion: ticket.spec,
    txVersion: ticket.txv,
    genesisHash: hexDecode(ticket.genesis.replace(/^0x/, '')),
    eraBirthHash: hexDecode(ticket.era.birthHash.replace(/^0x/, '')),
  });
  const ctx = te.encode(SIGNING_CONTEXT);
  const ok = mlDsa.verify(decoded.signature, payload, decoded.pubkey, { context: ctx });
  return { ok, payloadHex: '0x' + hexEncode(payload) };
}

/* Convenience: decode + attach the raw era bytes and raw call bytes the
 * verifier needs (kept separate so decodeSignedExtrinsic stays pure). */
export function decodeForVerify(hex) {
  const d = decodeSignedExtrinsic(hex);
  const raw = hexDecode(String(hex).replace(/^0x/, ''));
  const { next: o0 } = compactDecode(raw, 0);
  const body = raw.slice(o0);
  // walk to era + call again to capture exact bytes
  let o = 1 + 1 + 32 + 1;
  o += (d.variant === DILITHIUM65_VARIANT ? 3309 : 4627) + (d.variant === DILITHIUM65_VARIANT ? 1952 : 2592);
  const eraBytes = body.slice(o, o + 2); o += 2;
  o = compactDecode(body, o).next;
  o = compactDecode(body, o).next;
  o += 1; // metadata hash mode
  const rawCall = body.slice(o);
  return { ...d, eraBytes, rawCall };
}
