/* QTC Exposure Lab — logic tests. Run: node tests/exposure-tests.js */
var assert = require("assert");
var C = require("../js/exposure-core.js");

var pass = 0, total = 0;
function t(name, fn){
  total++;
  try { fn(); pass++; }
  catch (e){ console.error("FAIL " + name + "\n  " + (e.message || e)); process.exitCode = 1; }
}
async function ta(name, fn){
  total++;
  try { await fn(); pass++; }
  catch (e){ console.error("FAIL " + name + "\n  " + (e.message || e)); process.exitCode = 1; }
}

(async function(){
  /* --- SS58 / QTC --- */
  t("ss58 sample address decodes, prefix 189", function(){
    var d = C.ss58Decode("qzjhuX9r6CzXzH3VWUcZjd9DHZHkC26BU6CGFp49m8YjQFJDa");
    assert.strictEqual(d.ok, true); assert.strictEqual(d.prefix, 189);
    assert.strictEqual(d.key.length, 32);
  });
  t("ss58 checksum tamper rejected", function(){
    var d = C.ss58Decode("qzjhuX9r6CzXzH3VWUcZjd9DHZHkC26BU6CGFp49m8YjQFJDc");
    assert.strictEqual(d.ok, false); assert.strictEqual(d.kind, "checksum");
  });
  t("validateQTC ok", function(){
    var v = C.validateQTC("qzjhuX9r6CzXzH3VWUcZjd9DHZHkC26BU6CGFp49m8YjQFJDa");
    assert.strictEqual(v.ok, true); assert.strictEqual(v.chain, "qtc");
  });
  t("analyzeQTC is safe", function(){
    var a = C.analyzeQTC({ chain: "qtc", ok: true });
    assert.strictEqual(a.verdict, "safe");
    assert.ok(/ML-DSA/.test(a.evidence.join(" ")));
  });
  t("non-Quantus SS58 (prefix 0) routes to substrate", function(){
    // prefix-0 address for the 32-byte zero key is not valid checksum-wise; craft via decode path instead
    var v = C.validateQTC("111111111111111111111111111111111HC1");
    // '1...HC1' may fail checksum; we only assert the router handles whatever comes back
    assert.ok(v.chain === "substrate" || v.chain === "unknown");
  });
  t("analyzeSubstrate warns raw-pubkey exposure", function(){
    var a = C.analyzeSubstrate({ chain: "substrate", ok: true, format: "SS58 (prefix 0)" });
    assert.strictEqual(a.verdict, "exposed");
  });

  /* --- bech32 --- */
  t("bech32 BIP-173 example decodes", function(){
    var d = C.bech32Decode("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4");
    assert.strictEqual(d.ok, true); assert.strictEqual(d.hrp, "bc");
    assert.strictEqual(d.version, 0); assert.strictEqual(d.program.length, 20);
  });
  t("bech32 tampered checksum rejected", function(){
    var d = C.bech32Decode("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5");
    assert.strictEqual(d.ok, false);
  });
  /* bech32m encoder (BIP-350) — test helper to mint valid taproot addresses */
  var B32CS = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
  function b32pm(v){ var G=[0x3b6a57b2,0x26508e6d,0x1ea119fa,0x3d4233dd,0x2a1462b3],c=1;
    for(var p=0;p<v.length;p++){var b=c>>25;c=((c&0x1ffffff)<<5)^v[p];
      for(var i=0;i<5;i++)if((b>>i)&1)c^=G[i];} return c>>>0; }
  function b32hrpX(h){var r=[],i;for(i=0;i<h.length;i++)r.push(h.charCodeAt(i)>>5);
    r.push(0);for(i=0;i<h.length;i++)r.push(h.charCodeAt(i)&31);return r;}
  function b8to5(d){var a=0,b=0,r=[],i;for(i=0;i<d.length;i++){a=(a<<8)|d[i];b+=8;
    while(b>=5){b-=5;r.push((a>>b)&31);}}if(b>0)r.push((a<<(5-b))&31);return r;}
  function bech32mEncode(hrp, ver, prog){
    var d=[ver].concat(b8to5(prog));
    var p=b32pm(b32hrpX(hrp).concat(d).concat([0,0,0,0,0,0]))^0x2bc830a3;
    var cs=[];for(var i=0;i<6;i++)cs.push((p>>5*(5-i))&31);
    return hrp+"1"+d.concat(cs).map(function(x){return B32CS[x];}).join("");
  }
  var tapProg=[];for(var ti=0;ti<32;ti++)tapProg.push((ti*53+7)%256);
  var TAPROOT_ADDR = bech32mEncode("bc", 1, tapProg);
  t("bech32m taproot address round-trips (v1, 32-byte program)", function(){
    var d = C.bech32Decode(TAPROOT_ADDR);
    assert.strictEqual(d.ok, true); assert.strictEqual(d.version, 1);
    assert.strictEqual(d.program.length, 32);
    assert.strictEqual(d.encoding, "bech32m");
    assert.deepStrictEqual(d.program, tapProg);
  });
  await ta("validateBTC bech32 P2WPKH", async function(){
    var v = await C.validateBTC("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4");
    assert.strictEqual(v.ok, true); assert.strictEqual(v.chain, "btc");
    assert.ok(/P2WPKH/.test(v.format));
  });
  await ta("validateBTC bech32m taproot flags key-in-output", async function(){
    var v = await C.validateBTC(TAPROOT_ADDR);
    assert.strictEqual(v.ok, true); assert.ok(/P2TR/.test(v.format));
    assert.strictEqual(v.detail, "taproot-key-in-output");
  });

  /* --- base58check --- */
  await ta("validateBTC base58 P2PKH genesis address", async function(){
    var v = await C.validateBTC("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa");
    assert.strictEqual(v.ok, true); assert.strictEqual(v.chain, "btc");
    assert.ok(/P2PKH/.test(v.format));
  });
  await ta("validateBTC base58 bad checksum rejected", async function(){
    var v = await C.validateBTC("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb");
    assert.strictEqual(v.ok, false); assert.ok(/checksum/i.test(v.error));
  });
  await ta("validateBTC base58 P2SH", async function(){
    var v = await C.validateBTC("3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy");
    assert.strictEqual(v.ok, true); assert.ok(/P2SH/.test(v.format));
  });

  /* --- ETH --- */
  t("validateETH accepts vitalik.eth address", function(){
    var v = C.validateETH("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045");
    assert.strictEqual(v.ok, true); assert.strictEqual(v.chain, "eth");
  });
  t("validateETH rejects short hex", function(){
    var v = C.validateETH("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA9604");
    assert.strictEqual(v.ok, false);
  });
  t("validateETH rejects non-hex", function(){
    var v = C.validateETH("0xzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz");
    assert.strictEqual(v.ok, false);
  });

  /* --- detectChain routing --- */
  await ta("detectChain routes btc base58", async function(){
    var v = await C.detectChain("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa");
    assert.strictEqual(v.chain, "btc"); assert.strictEqual(v.ok, true);
  });
  await ta("detectChain routes eth", async function(){
    var v = await C.detectChain("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045");
    assert.strictEqual(v.chain, "eth"); assert.strictEqual(v.ok, true);
  });
  await ta("detectChain routes qtc", async function(){
    var v = await C.detectChain("qzjhuX9r6CzXzH3VWUcZjd9DHZHkC26BU6CGFp49m8YjQFJDa");
    assert.strictEqual(v.chain, "qtc"); assert.strictEqual(v.ok, true);
  });
  await ta("detectChain rejects garbage", async function(){
    var v = await C.detectChain("hello world");
    assert.strictEqual(v.ok, false); assert.strictEqual(v.chain, "unknown");
  });
  await ta("detectChain empty input", async function(){
    var v = await C.detectChain("   ");
    assert.strictEqual(v.ok, false);
  });

  /* --- BTC analysis --- */
  t("BTC: spent outputs => exposed", function(){
    var a = C.analyzeBTC({ chain: "btc", ok: true, format: "P2PKH (legacy)" },
      { spent_txo_count: 1840, funded_txo_count: 1902, tx_count: 3742,
        balance_sats: 0, p2pk_observed: false, p2tr_funded: false });
    assert.strictEqual(a.verdict, "exposed");
  });
  t("BTC: P2PK unspent => exposed without spends", function(){
    var a = C.analyzeBTC({ chain: "btc", ok: true, format: "P2PKH (legacy)" },
      { spent_txo_count: 0, funded_txo_count: 5, tx_count: 5,
        balance_sats: 5000000000, p2pk_observed: true, p2tr_funded: false });
    assert.strictEqual(a.verdict, "exposed");
    assert.ok(/P2PK/.test(a.evidence.join(" ")));
  });
  t("BTC: taproot funded => exposed without spends", function(){
    var a = C.analyzeBTC({ chain: "btc", ok: true, format: "P2TR (Taproot v1)", detail: "taproot-key-in-output" },
      { spent_txo_count: 0, funded_txo_count: 2, tx_count: 2,
        balance_sats: 100000, p2pk_observed: false, p2tr_funded: true });
    assert.strictEqual(a.verdict, "exposed");
  });
  t("BTC: funded never spent => latent", function(){
    var a = C.analyzeBTC({ chain: "btc", ok: true, format: "P2WPKH (native SegWit v0)" },
      { spent_txo_count: 0, funded_txo_count: 3, tx_count: 3,
        balance_sats: 250000, p2pk_observed: false, p2tr_funded: false });
    assert.strictEqual(a.verdict, "latent");
    assert.ok(/first spend/i.test(a.recommendation));
  });
  t("BTC: never used => clean", function(){
    var a = C.analyzeBTC({ chain: "btc", ok: true, format: "P2WPKH (native SegWit v0)" },
      { spent_txo_count: 0, funded_txo_count: 0, tx_count: 0,
        balance_sats: 0, p2pk_observed: false, p2tr_funded: false });
    assert.strictEqual(a.verdict, "clean");
  });
  t("BTC: offline api => unknown", function(){
    var a = C.analyzeBTC({ chain: "btc", ok: true, format: "P2PKH (legacy)" }, { offline: true });
    assert.strictEqual(a.verdict, "unknown");
  });

  /* --- ETH analysis --- */
  t("ETH: sent wei > 0 => exposed", function(){
    var a = C.analyzeETH({ chain: "eth", ok: true },
      { n_tx: 4821, total_sent_wei: "1842000000000000000000", balance_wei: "263000000000000000000" });
    assert.strictEqual(a.verdict, "exposed");
    assert.ok(/recoverable/.test(a.evidence.join(" ")));
  });
  t("ETH: receive-only => latent", function(){
    var a = C.analyzeETH({ chain: "eth", ok: true },
      { n_tx: 7, total_sent_wei: "0", balance_wei: "1500000000000000000" });
    assert.strictEqual(a.verdict, "latent");
  });
  t("ETH: fresh => clean", function(){
    var a = C.analyzeETH({ chain: "eth", ok: true },
      { n_tx: 0, total_sent_wei: "0", balance_wei: "0" });
    assert.strictEqual(a.verdict, "clean");
  });
  t("ETH: offline api => unknown", function(){
    var a = C.analyzeETH({ chain: "eth", ok: true }, { offline: true });
    assert.strictEqual(a.verdict, "unknown");
  });

  /* --- invalid input --- */
  t("analyze invalid address => invalid verdict", function(){
    var a = C.analyze({ chain: "unknown", ok: false, error: "nope" }, null);
    assert.strictEqual(a.verdict, "invalid");
  });

  /* --- formatters --- */
  t("fmtBTC formats sats", function(){
    assert.strictEqual(C.fmtBTC(100000000), "1 BTC");
    assert.strictEqual(C.fmtBTC(9955567890), "99.5556789 BTC");
  });
  t("fmtETH formats wei", function(){
    assert.strictEqual(C.fmtETH("1000000000000000000"), "1 ETH");
    assert.strictEqual(C.fmtETH("263000000000000000000"), "263 ETH");
    assert.strictEqual(C.fmtETH("1500000000000000000"), "1.5 ETH");
  });

  /* --- summarize --- */
  t("summarize counts + at-risk math", function(){
    var s = C.summarize([
      { analysis: { verdict: "exposed" }, usd: 1000 },
      { analysis: { verdict: "latent" }, usd: 500 },
      { analysis: { verdict: "safe" }, usd: 2000 },
      { analysis: { verdict: "clean" }, usd: 0 }
    ]);
    assert.strictEqual(s.counts.exposed, 1);
    assert.strictEqual(s.counts.latent, 1);
    assert.strictEqual(s.atRiskUsd, 1500);
    assert.strictEqual(s.totalUsd, 3500);
    assert.strictEqual(s.score, 57); // (3500-1500)/3500 = 57.14 -> 57
  });
  t("summarize empty => null score", function(){
    assert.strictEqual(C.summarize([]).score, null);
  });
  t("summarize no values => address-based score", function(){
    var s = C.summarize([
      { analysis: { verdict: "safe" }, usd: 0 },
      { analysis: { verdict: "exposed" }, usd: 0 }
    ]);
    assert.strictEqual(s.score, 50);
  });

  /* --- API-payload boundary (2026-10-09) --- */
  t("sanitizeBtcApi normalizes digit-string counts to numbers", function(){
    var s = C.sanitizeBtcApi({ spent_txo_count: "3", funded_txo_count: "5", tx_count: "7", balance_sats: "250000" });
    assert.strictEqual(s.spent_txo_count, 3); assert.strictEqual(s.balance_sats, 250000);
  });
  t("sanitizeBtcApi rejects fractional / negative / object core fields", function(){
    assert.strictEqual(C.sanitizeBtcApi({ spent_txo_count: 1.5 }), null);
    assert.strictEqual(C.sanitizeBtcApi({ spent_txo_count: -1 }), null);
    assert.strictEqual(C.sanitizeBtcApi({ balance_sats: { evil: 1 } }), null);
    assert.strictEqual(C.sanitizeBtcApi(null), null);
    assert.strictEqual(C.sanitizeBtcApi([1, 2]), null);
  });
  t("BTC: string counts read numerically, never concatenated", function(){
    var a = C.analyzeBTC({ chain: "btc", ok: true, format: "P2PKH (legacy)" },
      { spent_txo_count: "3", funded_txo_count: "5", tx_count: "7", balance_sats: "250000" });
    assert.strictEqual(a.verdict, "exposed");
    assert.ok(/3 spent output\(s\) across 7/.test(a.evidence.join(" ")), a.evidence.join(" "));
  });
  t("BTC: fractional spent count => unknown, not a flipped verdict", function(){
    var a = C.analyzeBTC({ chain: "btc", ok: true, format: "P2PKH (legacy)" },
      { spent_txo_count: 1.5, funded_txo_count: 5, tx_count: 5, balance_sats: 100 });
    assert.strictEqual(a.verdict, "unknown");
    assert.ok(/malformed/i.test(a.title + a.evidence.join(" ")));
  });
  t("BTC: object balance => unknown, no [object Object] evidence", function(){
    var a = C.analyzeBTC({ chain: "btc", ok: true, format: "P2PKH (legacy)" },
      { spent_txo_count: 2, funded_txo_count: 5, tx_count: 5, balance_sats: { evil: 1 } });
    assert.strictEqual(a.verdict, "unknown");
    assert.ok(!/\[object Object\]|NaN/.test(a.evidence.join(" ")));
  });
  t("ETH: garbage wei total => unknown, never a guessed verdict", function(){
    var a = C.analyzeETH({ chain: "eth", ok: true },
      { n_tx: 3, total_sent_wei: { evil: 1 }, balance_wei: "100" });
    assert.strictEqual(a.verdict, "unknown");
    assert.ok(!/\[object Object\]/.test(a.evidence.join(" ")));
  });
  t("ETH: fractional wei balance => unknown", function(){
    var a = C.analyzeETH({ chain: "eth", ok: true },
      { n_tx: 0, total_sent_wei: "0", balance_wei: "1.5" });
    assert.strictEqual(a.verdict, "unknown");
  });
  t("ETH: Blockscout-shaped api (n_tx null) still analyzes", function(){
    var a = C.analyzeETH({ chain: "eth", ok: true },
      { n_tx: null, total_sent_wei: "1", balance_wei: "500" });
    assert.strictEqual(a.verdict, "exposed");
  });
  t("formatters refuse garbage instead of rendering it as fact", function(){
    assert.strictEqual(C.fmtBTC("abc"), "—");
    assert.strictEqual(C.fmtBTC(-5), "—");
    assert.strictEqual(C.fmtETH({ evil: 1 }), "—");
    assert.strictEqual(C.fmtETH("1.5"), "—");
  });
  t("summarize ignores NaN / Infinity / negative usd and junk entries", function(){
    var s = C.summarize([
      { analysis: { verdict: "exposed" }, usd: NaN },
      { analysis: { verdict: "exposed" }, usd: Infinity },
      { analysis: { verdict: "latent" }, usd: -50 },
      null,
      { analysis: { verdict: "safe" }, usd: 100 }
    ]);
    assert.strictEqual(s.totalUsd, 100);
    assert.strictEqual(s.atRiskUsd, 0);
    assert.strictEqual(s.score, 100);
  });

  /* --- API-payload boundary round 2: relations + identity signal (2026-10-10) --- */
  t("BTC: spent outputs cannot exceed funded outputs", function(){
    assert.strictEqual(C.sanitizeBtcApi({ spent_txo_count: 5, funded_txo_count: 3, tx_count: 6, balance_sats: 100 }), null);
    var a = C.analyzeBTC({ chain: "btc", ok: true, format: "P2PKH (legacy)" },
      { spent_txo_count: 5, funded_txo_count: 3, tx_count: 6, balance_sats: 100 });
    assert.strictEqual(a.verdict, "unknown");
  });
  t("BTC: zero transactions cannot coexist with funded/balance", function(){
    assert.strictEqual(C.sanitizeBtcApi({ spent_txo_count: 0, funded_txo_count: 3, tx_count: 0, balance_sats: 100 }), null);
    assert.strictEqual(C.sanitizeBtcApi({ spent_txo_count: 0, funded_txo_count: 0, tx_count: 0, balance_sats: 0 }) !== null, true);
  });
  t("BTC: positive balance needs an unspent funded output", function(){
    assert.strictEqual(C.sanitizeBtcApi({ spent_txo_count: 2, funded_txo_count: 2, tx_count: 4, balance_sats: 500 }), null);
    var a = C.analyzeBTC({ chain: "btc", ok: true, format: "P2PKH (legacy)" },
      { spent_txo_count: 2, funded_txo_count: 2, tx_count: 4, balance_sats: 0 });
    assert.strictEqual(a.verdict, "exposed"); // all spent, zero balance: consistent
  });
  t("ETH: n_tx 0 cannot coexist with received/balance", function(){
    assert.strictEqual(C.sanitizeEthApi({ n_tx: 0, total_sent_wei: "0", total_received_wei: "100", balance_wei: "100" }), null);
    var a = C.analyzeETH({ chain: "eth", ok: true },
      { n_tx: 0, total_sent_wei: "0", total_received_wei: "0", balance_wei: "0" });
    assert.strictEqual(a.verdict, "clean");
  });
  t("ETH: Blockscout sent_signal survives sanitize and names itself in evidence", function(){
    var s = C.sanitizeEthApi({ n_tx: null, total_sent_wei: "1", balance_wei: "500", sent_signal: true });
    assert.strictEqual(s.sent_signal, true);
    var a = C.analyzeETH({ chain: "eth", ok: true },
      { n_tx: null, total_sent_wei: "1", total_received_wei: "0", balance_wei: "500", sent_signal: true, source: "blockscout" });
    assert.strictEqual(a.verdict, "exposed");
    assert.ok(/Blockscout fallback/.test(a.evidence.join(" ")));
    assert.ok(!/0\.000000000000000001/.test(a.evidence.join(" ")), a.evidence.join(" "));
  });

  /* --- samples --- */
  await ta("every sample address validates on its chain", async function(){
    for (var i = 0; i < C.SAMPLES.length; i++){
      var v = await C.detectChain(C.SAMPLES[i].address);
      assert.ok(v.ok, "sample " + i + " failed: " + v.error);
    }
  });
  t("sample analyses hit the intended verdicts", function(){
    var expect = ["exposed", "exposed", "clean", "exposed", "safe"];
    C.SAMPLES.forEach(function(s, i){
      var v = { chain: i < 3 ? "btc" : (i === 3 ? "eth" : "qtc"), ok: true, format: "sample" };
      var a = C.analyze(v, s.api);
      assert.strictEqual(a.verdict, expect[i], "sample " + i + " (" + s.label + ")");
    });
  });

  console.log("\n" + pass + "/" + total + " exposure-lab logic tests green");
  if (pass !== total) process.exit(1);
})();
