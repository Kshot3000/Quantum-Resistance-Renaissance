/* QTC Energy Observatory — energy-core.js
 * Pure energy math for the Quantus network. No DOM, no network.
 *
 * Hashrate semantics (verified in the Consensus Lab against
 * Quantus-Network/chain pallets/qpow): E[hashes to win a block] = D, the
 * network targets one block per 12 s, so implied network hashrate = D / 12.
 * Power follows from hardware efficiency: W = (H/s) / (H/J).
 * Efficiency is an ASSUMPTION about the fleet — every derived power/energy
 * number must be presented as a band or with its assumption labeled.
 *
 * Plain script (no modules): loaded via <script> in the browser, required by
 * node for the test suite. Difficulties up to ~1e15 are exactly representable
 * as Numbers, so plain arithmetic is fine.
 */
"use strict";

var EnergyCore = (function () {
  var BLOCK_TARGET_MS = 12000;
  var BLOCK_TARGET_S = 12;
  var PLANCK = 1e12;
  var MAX_SUPPLY_QTC = 21e6;
  var EMISSION_DENOM = 50e6;
  var BLOCKS_PER_DAY = 86400 / BLOCK_TARGET_S; // 7200
  var HOURS_PER_YEAR = 8760;

  /* ---------- network physics ---------- */

  // Implied network hashrate in H/s from a difficulty value (string or number).
  function hashrateHs(difficulty) {
    return Number(difficulty) / BLOCK_TARGET_S;
  }

  // Network electrical power in watts from hashrate and fleet efficiency.
  // effMHperJ: megahashes per joule — the fleet's assumed efficiency.
  function powerW(hashrateHs, effMHperJ) {
    if (!(effMHperJ > 0)) return NaN;
    return hashrateHs / (effMHperJ * 1e6);
  }

  function powerMW(hashrateHs_, effMHperJ) {
    return powerW(hashrateHs_, effMHperJ) / 1e6;
  }

  // Annual energy from continuous power.
  function annualTWh(powerMW) { return (powerMW * HOURS_PER_YEAR) / 1e6; }
  function annualMWh(powerMW) { return powerMW * HOURS_PER_YEAR; }

  // Energy burned to produce one block (kWh), at given network power.
  function perBlockEnergyKWh(powerW_, blockTimeS) {
    return (powerW_ * (blockTimeS || BLOCK_TARGET_S)) / 3.6e6;
  }

  // Energy per transfer (kWh) at given network power and tx rate. Returns
  // Infinity when txPerSec is 0 — the "dividing by a young chain" reality.
  function perTxEnergyKWh(powerW_, txPerSec) {
    if (!(txPerSec > 0)) return Infinity;
    return powerW_ / txPerSec / 3.6e6; // J per tx → kWh
  }

  // Transfers per second from a cumulative transfer count over N blocks.
  function txRatePerSec(totalTransfers, blocks, blockTimeS) {
    if (!(blocks > 0) || !(blockTimeS > 0)) return NaN;
    return totalTransfers / (blocks * blockTimeS);
  }

  // Current block reward per pallets/mining-rewards on_finalize (verified against
  // Quantus-Network/chain, 2026-10-02):
  //   R = (MaxSupply − total_issuance) / 50_000_000
  // where total_issuance = Currency::total_issuance() INCLUDES genesis endowments.
  // Pass total supply (data/supply.json total_supply_plancks), NOT mined rewards
  // alone — mined-only input overstates the reward by ~37% at current supply.
  function blockRewardQtc(totalSupplyPlancks) {
    return (MAX_SUPPLY_QTC - Number(totalSupplyPlancks) / PLANCK) / EMISSION_DENOM;
  }

  // Expected QTC/day for a rig = its share of blocks × reward.
  function rigExpectedQtcPerDay(rigHs, netHs, rewardQtc) {
    if (!(netHs > 0) || !(rigHs > 0)) return 0;
    return (rigHs / netHs) * BLOCKS_PER_DAY * rewardQtc;
  }

  function dailyKwh(powerW_) { return (powerW_ * 24) / 1000; }
  function electricityCostUsd(kwh, rateUsdPerKwh) { return kwh * rateUsdPerKwh; }

  // CO2: annualKwh * kg/kWh / 1000 = tonnes.
  function co2Tonnes(annualKwh, kgPerKwh) {
    return (annualKwh * kgPerKwh) / 1000;
  }

  /* ---------- fleet mix efficiency ----------
   * For a fleet made of parts with hashrate shares and per-part efficiency,
   * the fleet efficiency is the hashrate-weighted harmonic mean:
   *   eff = 1 / sum(share_i / eff_i). */

  function mixEfficiency(parts) {
    var inv = 0;
    for (var i = 0; i < parts.length; i++) {
      if (!(parts[i].mhPerJ > 0) || !(parts[i].share >= 0)) return NaN;
      inv += parts[i].share / parts[i].mhPerJ;
    }
    if (!(inv > 0)) return NaN;
    return 1 / inv;
  }

  /* ---------- history aggregation ----------
   * trend: array of [height, tsMs, diffStr] sampled ~every 100 blocks.
   * Returns daily buckets {date: "YYYY-MM-DD", samples, avgHashrateHs,
   * mwh} where mwh assumes effMHperJ efficiency held all day. */

  function dailyEnergyHistory(trend, effMHperJ) {
    var days = {};
    for (var i = 0; i < trend.length; i++) {
      var p = trend[i];
      var d = new Date(p[1]);
      var key =
        d.getUTCFullYear() + "-" +
        ("0" + (d.getUTCMonth() + 1)).slice(-2) + "-" +
        ("0" + d.getUTCDate()).slice(-2);
      if (!days[key]) days[key] = { sum: 0, n: 0 };
      days[key].sum += hashrateHs(p[2]);
      days[key].n += 1;
    }
    var keys = Object.keys(days).sort();
    return keys.map(function (k) {
      var avg = days[k].sum / days[k].n;
      var mw = powerMW(avg, effMHperJ);
      return {
        date: k,
        samples: days[k].n,
        avgHashrateHs: avg,
        mwh: annualMWh(mw) / 365,
      };
    });
  }

  // Find the trend point at the greatest height <= targetHeight.
  function trendPointAtOrBelow(trend, targetHeight) {
    var best = null;
    for (var i = 0; i < trend.length; i++) {
      if (trend[i][0] <= targetHeight) best = trend[i];
      else break;
    }
    return best;
  }

  /* ---------- measured hardware presets ----------
   * All from upstream Quantus-Network/quantus-miner bench docs (Vast.ai and
   * Clore.ai rented GPUs, `quantus-miner benchmark`, GPU-only). hashrateMHs is
   * the measured midpoint of the reported range; powerW is the nvidia-smi
   * power CAP where measured, otherwise board TDP (noted in powerNote).
   * mhPerJ is derived: hashrate / power. */

  var HARDWARE_PRESETS = [
    {
      id: "rtx4090-pr100",
      name: "RTX 4090",
      hashrateMHs: 818,
      hashrateNote: "816–820 MH/s range",
      powerW: 350,
      powerNote: "350 W nvidia-smi power cap (measured)",
      engine: "CUDA (native NVRTC kernel)",
      source: "Quantus-Network/quantus-miner docs/vast-gpu-benches.md",
      sourceUrl: "https://github.com/Quantus-Network/quantus-miner/blob/main/docs/vast-gpu-benches.md",
      date: "2026-09-10",
      conditions: "PR #100 same-host A/B, three alternating 30 s runs, miner v4.x",
    },
    {
      id: "rtx3080ti-pr100",
      name: "RTX 3080 Ti",
      hashrateMHs: 380.5,
      hashrateNote: "380–381 MH/s range",
      powerW: 330,
      powerNote: "330 W nvidia-smi power cap (measured)",
      engine: "CUDA (native NVRTC kernel)",
      source: "Quantus-Network/quantus-miner docs/vast-gpu-benches.md",
      sourceUrl: "https://github.com/Quantus-Network/quantus-miner/blob/main/docs/vast-gpu-benches.md",
      date: "2026-09-10",
      conditions: "PR #100 same-host A/B, three alternating 30 s runs, miner v4.x",
    },
    {
      id: "rtx3080ti-cuda402",
      name: "RTX 3080 Ti",
      hashrateMHs: 273.83,
      hashrateNote: "single 10 s run",
      powerW: 300,
      powerNote: "300 W nvidia-smi power cap on the Vast.ai host (measured)",
      engine: "CUDA (native NVRTC kernel), v4.0.2",
      source: "Quantus-Network/quantus-miner docs/vast-gpu-benches.md",
      sourceUrl: "https://github.com/Quantus-Network/quantus-miner/blob/main/docs/vast-gpu-benches.md",
      date: "2026-09-04",
      conditions: "`quantus-miner benchmark --cuda-gpu --cpu-workers 0 --gpu-devices 1`, 10 s, Vast instance 49862636",
    },
    {
      id: "rtx3080ti-wgsl402",
      name: "RTX 3080 Ti",
      hashrateMHs: 106.03,
      hashrateNote: "single 10 s run",
      powerW: 300,
      powerNote: "300 W nvidia-smi power cap on the Vast.ai host (measured)",
      engine: "WGSL (default wgpu/Vulkan engine), v4.0.2",
      source: "Quantus-Network/quantus-miner docs/vast-gpu-benches.md",
      sourceUrl: "https://github.com/Quantus-Network/quantus-miner/blob/main/docs/vast-gpu-benches.md",
      date: "2026-09-04",
      conditions: "`quantus-miner benchmark --cpu-workers 0 --gpu-devices 1`, 10 s, Vast instance 49862636",
    },
    {
      id: "rtx5060ti",
      name: "RTX 5060 Ti 16GB",
      hashrateMHs: 104.5,
      hashrateNote: "single 10 s run",
      powerW: 180,
      powerNote: "180 W board TDP — NOT a measured cap; wall power will differ",
      engine: "CUDA (native NVRTC kernel), v4.0.2",
      source: "Quantus-Network/quantus-miner docs/clore-gpu-benches.md",
      sourceUrl: "https://github.com/Quantus-Network/quantus-miner/blob/main/docs/clore-gpu-benches.md",
      date: "2026-09-04",
      conditions: "`quantus-miner benchmark --cuda-gpu --cpu-workers 0 --gpu-devices 1`, 10 s",
    },
    {
      id: "rtx4060ti",
      name: "RTX 4060 Ti 8GB",
      hashrateMHs: 79.13,
      hashrateNote: "single 10 s run",
      powerW: 160,
      powerNote: "160 W board TDP — NOT a measured cap; the bench host was observed with a 100 W nvidia-smi cap, so wall power will differ",
      engine: "CUDA (native NVRTC kernel), v4.0.2",
      source: "Quantus-Network/quantus-miner docs/clore-gpu-benches.md",
      sourceUrl: "https://github.com/Quantus-Network/quantus-miner/blob/main/docs/clore-gpu-benches.md",
      date: "2026-09-04",
      conditions: "`quantus-miner benchmark --cuda-gpu --cpu-workers 0 --gpu-devices 1`, 10 s",
    },
    {
      id: "rtx3070",
      name: "RTX 3070 8GB",
      hashrateMHs: 81.49,
      hashrateNote: "single 10 s run",
      powerW: 220,
      powerNote: "220 W board TDP — NOT a measured cap; wall power will differ",
      engine: "CUDA (native NVRTC kernel), v4.0.2",
      source: "Quantus-Network/quantus-miner docs/clore-gpu-benches.md",
      sourceUrl: "https://github.com/Quantus-Network/quantus-miner/blob/main/docs/clore-gpu-benches.md",
      date: "2026-09-04",
      conditions: "`quantus-miner benchmark --cuda-gpu --cpu-workers 0 --gpu-devices 1`, 10 s",
    },
    {
      id: "rtx3060ti",
      name: "RTX 3060 Ti 8GB",
      hashrateMHs: 68.04,
      hashrateNote: "single 10 s run",
      powerW: 200,
      powerNote: "200 W board TDP — NOT a measured cap; wall power will differ",
      engine: "CUDA (native NVRTC kernel), v4.0.2",
      source: "Quantus-Network/quantus-miner docs/clore-gpu-benches.md",
      sourceUrl: "https://github.com/Quantus-Network/quantus-miner/blob/main/docs/clore-gpu-benches.md",
      date: "2026-09-04",
      conditions: "`quantus-miner benchmark --cuda-gpu --cpu-workers 0 --gpu-devices 1`, 10 s",
    },
  ];

  function presetById(id) {
    for (var i = 0; i < HARDWARE_PRESETS.length; i++) {
      if (HARDWARE_PRESETS[i].id === id) return HARDWARE_PRESETS[i];
    }
    return null;
  }

  function presetEfficiency(p) {
    return p.hashrateMHs / p.powerW; // MH/J
  }

  // Fleet builder: rows of {presetId, count} → totals.
  function fleetTotals(rows) {
    var totalHs = 0, totalW = 0, gpus = 0;
    for (var i = 0; i < rows.length; i++) {
      var p = presetById(rows[i].presetId);
      var n = Math.max(0, Math.floor(rows[i].count || 0));
      if (!p || n <= 0) continue;
      totalHs += p.hashrateMHs * 1e6 * n;
      totalW += p.powerW * n;
      gpus += n;
    }
    return { hashrateHs: totalHs, powerW: totalW, gpus: gpus };
  }

  /* ---------- external figures (verified research, 2026-10-01) ----------
   * Every entry carries value, unit, source name + URL, and date. Entries that
   * could not be verified are OMITTED (not guessed) — the UI says so.
   * bitcoin_sustainable_share etc. are single-source best estimates, shown with
   * their provenance in the Methodology tab. */

  var EXTERNAL = {
    bitcoin_annual_twh_ccaf: {
      value: 138, unit: "TWh/yr",
      label: "Bitcoin — Cambridge (central estimate)",
      source: "Cambridge Centre for Alternative Finance, via statistics roundups",
      sourceUrl: "https://sqmagazine.co.uk/bitcoin-energy-consumption-statistics/",
      date: "2026-09-01",
      note: "Hashrate-weighted hardware-basket model, 7-day moving average; about 0.5% of global electricity.",
    },
    bitcoin_annual_twh_digiconomist: {
      value: 204.44, unit: "TWh/yr",
      label: "Bitcoin — Digiconomist (economic model)",
      source: "Digiconomist Bitcoin Energy Consumption Index, via statistics roundup",
      sourceUrl: "https://coinlaw.io/bitcoin-energy-consumption-statistics/",
      date: "2026-09-05",
      note: "Reading captured Sept 5, 2026; ~48% higher than Cambridge — the honest answer is a range.",
    },
    bitcoin_sustainable_share_pct: {
      value: 52.4, unit: "%",
      label: "Bitcoin mining electricity from sustainable sources",
      source: "Cambridge Digital Mining Industry Report",
      sourceUrl: "https://blofin.com/en/academy/education/bitcoin/bitcoin-energy-use",
      date: "2025-04-28",
      note: "42.6% renewables + 9.8% nuclear, from a 49-firm survey covering 48% of global hashrate; up from 37.6% in 2022.",
    },
    ethereum_annual_twh_upper: {
      value: 0.01, unit: "TWh/yr",
      label: "Ethereum post-merge (upper bound)",
      source: "How Blockchains Actually Work (cloudstreet-dev), citing CBECI-adjacent estimates",
      sourceUrl: "https://github.com/cloudstreet-dev/how-blockchains-actually-work/blob/HEAD/src/ch08_pow_vs_pos.md",
      date: "2026-01-01",
      note: "Consensus-layer estimate 'under 0.01 TWh/yr' — used here as an upper bound, not an exact figure.",
    },
    global_datacenters_twh_2024: {
      value: 415, unit: "TWh",
      label: "Global data centers, 2024",
      source: "International Energy Agency (IEA), via BloFin",
      sourceUrl: "https://blofin.com/en/academy/education/bitcoin/bitcoin-energy-use",
      date: "2024-01-01",
      note: "2024 global data-center electricity; IEA projects ~945 TWh by 2030, driven mainly by AI.",
    },
    us_home_kwh_2022: {
      value: 10791, unit: "kWh/yr",
      label: "Average U.S. home electricity use",
      source: "U.S. Energy Information Administration (EIA), 2022 residential average",
      sourceUrl: "http://www.eia.gov/electricity/monthly/epm_table_grapher.cfm?t=epmt_1_1_a",
      date: "2022-01-01",
      note: "Average annual electricity consumption for a U.S. residential utility customer, 2022.",
    },
  };

  /* ---------- formatting ---------- */

  function fmtHashrate(hs) {
    if (!(hs > 0)) return "—";
    var units = ["H/s", "KH/s", "MH/s", "GH/s", "TH/s", "PH/s", "EH/s"];
    var i = 0;
    while (hs >= 1000 && i < units.length - 1) { hs /= 1000; i++; }
    return hs.toFixed(2) + " " + units[i];
  }

  function fmtPowerMW(mw) {
    if (!(mw > 0)) return "—";
    if (mw >= 1000) return (mw / 1000).toFixed(2) + " GW";
    if (mw >= 1) return mw.toFixed(2) + " MW";
    return (mw * 1000).toFixed(1) + " kW";
  }

  function fmtKwh(kwh) {
    if (!(kwh > 0)) return "—";
    if (kwh >= 1e9) return (kwh / 1e9).toFixed(2) + " TWh";
    if (kwh >= 1e6) return (kwh / 1e6).toFixed(2) + " GWh";
    if (kwh >= 1e3) return (kwh / 1e3).toFixed(2) + " MWh";
    return kwh.toFixed(2) + " kWh";
  }

  function fmtJoules(j) {
    if (!(j > 0)) return "—";
    if (j >= 1e9) return (j / 1e9).toFixed(1) + " GJ";
    if (j >= 1e6) return (j / 1e6).toFixed(1) + " MJ";
    if (j >= 1e3) return (j / 1e3).toFixed(1) + " kJ";
    return j.toFixed(1) + " J";
  }

  function fmtMoney(usd) {
    if (!(usd >= 0)) return "—";
    if (usd >= 1e6) return "$" + (usd / 1e6).toFixed(2) + "M";
    if (usd >= 1e3) return "$" + (usd / 1e3).toFixed(2) + "k";
    return "$" + usd.toFixed(2);
  }

  function fmtNum(n, digits) {
    if (!isFinite(n)) return "—";
    return n.toLocaleString("en-US", {
      minimumFractionDigits: digits == null ? 0 : digits,
      maximumFractionDigits: digits == null ? 0 : digits,
    });
  }

  return {
    BLOCK_TARGET_S: BLOCK_TARGET_S,
    BLOCKS_PER_DAY: BLOCKS_PER_DAY,
    hashrateHs: hashrateHs,
    powerW: powerW,
    powerMW: powerMW,
    annualTWh: annualTWh,
    annualMWh: annualMWh,
    perBlockEnergyKWh: perBlockEnergyKWh,
    perTxEnergyKWh: perTxEnergyKWh,
    txRatePerSec: txRatePerSec,
    blockRewardQtc: blockRewardQtc,
    rigExpectedQtcPerDay: rigExpectedQtcPerDay,
    dailyKwh: dailyKwh,
    electricityCostUsd: electricityCostUsd,
    co2Tonnes: co2Tonnes,
    mixEfficiency: mixEfficiency,
    dailyEnergyHistory: dailyEnergyHistory,
    trendPointAtOrBelow: trendPointAtOrBelow,
    HARDWARE_PRESETS: HARDWARE_PRESETS,
    presetById: presetById,
    presetEfficiency: presetEfficiency,
    fleetTotals: fleetTotals,
    EXTERNAL: EXTERNAL,
    fmtHashrate: fmtHashrate,
    fmtPowerMW: fmtPowerMW,
    fmtKwh: fmtKwh,
    fmtJoules: fmtJoules,
    fmtMoney: fmtMoney,
    fmtNum: fmtNum,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = EnergyCore;
}
