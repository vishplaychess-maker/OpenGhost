'use strict';

// The Trading Chart's data, gathered in the main process because the page's own policy lets it reach only its model
// provider. One source per chart, and the chart always names the one it used:
//   • PAX Gold on Binance — a token that tracks bullion ounce for ounce, traded around the clock, and the one source
//     here that also has a real bid/ask, so the spread shown is measured, never invented;
//   • Yahoo's COMEX gold futures (GC=F) — the gold market itself, no bid/ask;
//   • a sample series, written only when neither could be reached. It says so on the chart and gets no spread.
// Indicators come from technicalindicators over the closes of whichever source was used.

const { SMA, EMA, RSI } = require('technicalindicators');

const BINANCE = 'https://api.binance.com/api/v3';
const YAHOO = 'https://query1.finance.yahoo.com/v8/finance/chart';
const LIMIT = 300;
const WAIT = 10000;
const PERIODS = { sma: 20, ema: 50, rsi: 14 };
// What each of the view's time frames asks of each source.
const INTERVALS = {
 '1h': { binance: '1h', yahoo: '60m', range: '3mo' },
 '4h': { binance: '4h', yahoo: '60m', range: '1y' },
 '1d': { binance: '1d', yahoo: '1d', range: '2y' },
};

const round = value => Math.round(value * 100) / 100;

async function json(url) {
 const response = await fetch(url, { signal: AbortSignal.timeout(WAIT), headers: { Accept: 'application/json' } });
 if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
 return response.json();
}

// Binance answers candles as arrays: [open time, open, high, low, close, …]. The book ticker beside them gives the one
// real bid and ask this feature can show.
async function fromBinance(interval) {
 const bars = INTERVALS[interval]?.binance || '1d';
 const [klines, book] = await Promise.all([
  json(`${BINANCE}/klines?symbol=PAXGUSDT&interval=${bars}&limit=${LIMIT}`),
  json(`${BINANCE}/ticker/bookTicker?symbol=PAXGUSDT`).catch(() => null),
 ]);
 const candles = (Array.isArray(klines) ? klines : [])
  .map(row => ({ time: Math.floor(Number(row[0]) / 1000), open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]) }))
  .filter(candle => Number.isFinite(candle.time) && Number.isFinite(candle.close) && candle.time > 0);
 if (candles.length < PERIODS.ema) throw Error('too few candles');
 let spread = null;
 const bid = Number(book?.bidPrice), ask = Number(book?.askPrice);
 if (Number.isFinite(bid) && Number.isFinite(ask) && ask >= bid) spread = { bid, ask, value: round(ask - bid) };
 return {
  source: 'binance',
  label: 'PAX Gold · PAXG/USDT · Binance',
  symbol: 'XAU/USD ≈ PAXG/USDT',
  candles,
  spread,
  asOf: Date.now(),
 };
}

// Yahoo's chart API: parallel timestamp and quote arrays, with holes where the market did not trade.
async function fromYahoo(interval) {
 const at = INTERVALS[interval] || INTERVALS['1d'];
 const body = await json(`${YAHOO}/GC=F?interval=${at.yahoo}&range=${at.range}`);
 const result = body?.chart?.result?.[0];
 const stamps = result?.timestamp, quote = result?.indicators?.quote?.[0];
 if (!Array.isArray(stamps) || !Array.isArray(quote?.close)) throw Error('no candles');
 const candles = [];
 for (let k = 0; k < stamps.length; k++) {
  const open = Number(quote.open?.[k]), high = Number(quote.high?.[k]), low = Number(quote.low?.[k]), close = Number(quote.close?.[k]);
  if (![open, high, low, close].every(Number.isFinite)) continue;
  candles.push({ time: Math.floor(Number(stamps[k])), open, high, low, close });
 }
 if (candles.length < PERIODS.ema) throw Error('too few candles');
 return { source: 'yahoo', label: 'Gold futures · GC=F · Yahoo Finance', symbol: 'XAU/USD ≈ COMEX GC=F', candles, spread: null, asOf: Date.now() };
}

// A walk that is the same every time for a given day and time frame, so the chart does not change under a reload while
// it is labelled as sample data.
function sample(interval) {
 const seed = Number(String(new Date().toISOString().slice(0, 10)).replace(/-/g, '')) + (interval === '1h' ? 1 : interval === '4h' ? 2 : 3);
 let state = seed >>> 0;
 const next = () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 4294967296; };
 const step = interval === '1h' ? 3600 : interval === '4h' ? 14400 : 86400;
 const end = Math.floor(Date.now() / 1000 / step) * step;
 const candles = [];
 let price = 3800 + (seed % 100) / 10;
 for (let k = LIMIT - 1; k >= 0; k--) {
  const drift = Math.sin((k + seed % 37) / 14) * 0.9 + (next() - 0.5) * 6.4;
  const open = price;
  const close = Math.max(500, open + drift);
  const high = Math.max(open, close) + next() * 2.4;
  const low = Math.min(open, close) - next() * 2.4;
  candles.push({ time: end - k * step, open: round(open), high: round(high), low: round(low), close: round(close) });
  price = close;
 }
 return {
  source: 'sample',
  label: 'Sample series · not a live quote',
  symbol: 'XAU/USD',
  candles,
  spread: null,
  note: 'No market source could be reached, so this is generated sample data — not a live quote.',
  asOf: Date.now(),
 };
}

// technicalindicators returns values from the period's end onward; each is put back on the candle it belongs to. A
// moving average needs `period` closes and lands on the last of them; the RSI needs `period` changes, so it needs one
// close more and lands one candle later.
function plot(candles, values, from) {
 return values.map((value, index) => ({ time: candles[index + from].time, value: round(value) }));
}

function indicators(candles) {
 const closes = candles.map(candle => candle.close);
 const sma = SMA.calculate({ period: PERIODS.sma, values: closes });
 const ema = EMA.calculate({ period: PERIODS.ema, values: closes });
 const rsi = RSI.calculate({ period: PERIODS.rsi, values: closes });
 return {
  sma: { period: PERIODS.sma, points: closes.length >= PERIODS.sma ? plot(candles, sma, PERIODS.sma - 1) : [] },
  ema: { period: PERIODS.ema, points: closes.length >= PERIODS.ema ? plot(candles, ema, PERIODS.ema - 1) : [] },
  rsi: { period: PERIODS.rsi, points: closes.length > PERIODS.rsi ? plot(candles, rsi, PERIODS.rsi) : [] },
 };
}

// `offline` is for the tests: it asks for the sample without touching the network.
async function history({ interval = '1d', offline = false } = {}) {
 const asked = INTERVALS[interval] ? interval : '1d';
 let data = null, trouble = [];
 if (!offline) {
  for (const source of [fromBinance, fromYahoo]) {
   try { data = await source(asked); break; } catch (error) { trouble.push(error.message || String(error)); }
  }
 }
 if (!data) {
  data = sample(asked);
  if (trouble.length) data.note = `${data.note} (${trouble.join('; ')})`;
 }
 return { ...data, interval: asked, indicators: indicators(data.candles) };
}

module.exports = { history, indicators, INTERVALS, PERIODS };
