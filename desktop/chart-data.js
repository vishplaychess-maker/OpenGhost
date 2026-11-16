'use strict';

// The Trading Chart's data, gathered in the main process because the page's own policy lets it reach only its model
// provider. One source per chart, drawn at a measured interval, and the chart always names the one it used:
//   • Yahoo's COMEX gold futures (GC=F) — real gold, keyless, and measured from this machine at every frame the view
//     offers, 1m through 1mo, with OHLC and a real volume; it publishes no bid and ask;
//   • PAX Gold on Binance — a token that tracks bullion ounce for ounce, traded around the clock; a proxy, clearly
//     named as one, and the one source here with a real bid/ask, so the spread shown is measured, never invented;
//   • a sample series, written only when neither could be reached. It says so on the chart and gets no spread.
// Real gold is asked for first. Indicators come from technicalindicators over the closes of whichever source was used.

const { SMA, EMA, RSI } = require('technicalindicators');

const BINANCE = 'https://api.binance.com/api/v3';
const YAHOO = 'https://query1.finance.yahoo.com/v8/finance/chart';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';
const LIMIT = 300;
const WAIT = 10000;
const PERIODS = { ma: 9, sma: 20, ema: 50, rsi: 14 };
// The frames of a broker terminal, in its order, and what each asks of each feed. Yahoo's ranges are its own hard
// limits, measured: 1m stops at 7 days, 5–30m at 60, and 1h/4h take two years.
const FRAMES = ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1wk', '1mo'];
const INTERVALS = {
 '1m': { yahoo: '1m', range: '7d', binance: '1m', step: 60 },
 '5m': { yahoo: '5m', range: '60d', binance: '5m', step: 300 },
 '15m': { yahoo: '15m', range: '60d', binance: '15m', step: 900 },
 '30m': { yahoo: '30m', range: '60d', binance: '30m', step: 1800 },
 '1h': { yahoo: '60m', range: '2y', binance: '1h', step: 3600 },
 '4h': { yahoo: '4h', range: '2y', binance: '4h', step: 14400 },
 '1d': { yahoo: '1d', range: '5y', binance: '1d', step: 86400 },
 '1wk': { yahoo: '1wk', range: '10y', binance: '1w', step: 604800 },
 '1mo': { yahoo: '1mo', range: '10y', binance: '1M', step: 2592000 },
};
// Real gold first, the tokenized proxy second, the sample last.
const SOURCES = ['yahoo', 'binance', 'sample'];
// What the chart says it is drawing. Never a bare claim of XAU/USD: the futures are futures, the token is a proxy.
const FEEDS = {
 yahoo: { symbol: 'GC=F · COMEX', label: 'COMEX gold futures · Yahoo Finance' },
 binance: { symbol: 'XAU/USD ≈ PAXG/USDT', label: 'PAX Gold proxy · Binance (not spot XAU)' },
 sample: { symbol: 'XAU/USD · sample', label: 'Sample series · not a live quote' },
};
const supports = (source, interval) => source === 'sample' ? FRAMES.includes(interval) : !!INTERVALS[interval]?.[source];
const supported = source => FRAMES.filter(interval => supports(source, interval));

const round = value => Math.round(value * 100) / 100;

async function json(url) {
 const response = await fetch(url, { signal: AbortSignal.timeout(WAIT), headers: { Accept: 'application/json', 'User-Agent': UA } });
 if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
 return response.json();
}

// The bars a feed gave, cut to the view's own length, with the volume kept on the same times as the candles.
function sliced(bars) {
 const kept = bars.slice(-LIMIT);
 return {
  candles: kept.map(({ volume, ...candle }) => candle),
  volume: kept.map(bar => ({ time: bar.time, value: bar.volume })),
 };
}

// Binance answers candles as arrays: [open time, open, high, low, close, volume, …]. The book ticker beside them
// gives the one real bid and ask this feature can show.
async function fromBinance(interval) {
 const bars = INTERVALS[interval]?.binance;
 if (!bars) throw Error('this source has no such frame');
 const [klines, book] = await Promise.all([
  json(`${BINANCE}/klines?symbol=PAXGUSDT&interval=${bars}&limit=${LIMIT}`),
  json(`${BINANCE}/ticker/bookTicker?symbol=PAXGUSDT`).catch(() => null),
 ]);
 const rows = (Array.isArray(klines) ? klines : [])
  .map(row => ({ time: Math.floor(Number(row[0]) / 1000), open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]), volume: Number(row[5]) || 0 }))
  .filter(bar => Number.isFinite(bar.time) && Number.isFinite(bar.close) && bar.time > 0);
 if (rows.length < PERIODS.ema) throw Error('too few candles');
 let spread = null;
 const bid = Number(book?.bidPrice), ask = Number(book?.askPrice);
 if (Number.isFinite(bid) && Number.isFinite(ask) && ask >= bid) spread = { bid, ask, value: round(ask - bid) };
 return { source: 'binance', ...FEEDS.binance, ...sliced(rows), spread, asOf: Date.now() };
}

// One answer can disagree with itself. Yahoo has served a daily series whose last bar sat far from the market price the
// same answer named — another contract's curve, not this instrument today. Such a series is refused rather than drawn:
// the chart falls back to the proxy, which says what it is. A price the answer does not carry cannot condemn it.
const PLAUSIBLE = 0.03;
const plausible = (close, price) => {
 const named = Number(price);
 if (!Number.isFinite(close) || !Number.isFinite(named) || named <= 0) return true;
 return Math.abs(close - named) / named <= PLAUSIBLE;
};

// Yahoo's chart API: parallel timestamp and quote arrays, with holes where the market did not trade.
async function fromYahoo(interval) {
 const at = INTERVALS[interval];
 if (!at?.yahoo) throw Error('this source has no such frame');
 const body = await json(`${YAHOO}/GC=F?interval=${at.yahoo}&range=${at.range}`);
 const result = body?.chart?.result?.[0];
 const stamps = result?.timestamp, quote = result?.indicators?.quote?.[0];
 if (!Array.isArray(stamps) || !Array.isArray(quote?.close)) throw Error('no candles');
 const rows = [];
 for (let k = 0; k < stamps.length; k++) {
  const open = Number(quote.open?.[k]), high = Number(quote.high?.[k]), low = Number(quote.low?.[k]), close = Number(quote.close?.[k]);
  if (![open, high, low, close].every(Number.isFinite)) continue;
  rows.push({ time: Math.floor(Number(stamps[k])), open, high, low, close, volume: Number(quote.volume?.[k]) || 0 });
 }
 if (rows.length < PERIODS.ema) throw Error('too few candles');
 if (!plausible(rows[rows.length - 1].close, result.meta?.regularMarketPrice)) throw Error('the series disagrees with the quote it carries');
 // Yahoo publishes no bid and ask for the futures, so the chart shows none rather than a proxy's spread.
 return { source: 'yahoo', ...FEEDS.yahoo, ...sliced(rows), spread: null, asOf: Date.now() };
}

// A walk that is the same every time for a given day and time frame, so the chart does not change under a reload while
// it is labelled as sample data.
function sample(interval) {
 const at = INTERVALS[interval] || INTERVALS['1d'];
 const seed = Number(String(new Date().toISOString().slice(0, 10)).replace(/-/g, '')) + FRAMES.indexOf(interval);
 let state = seed >>> 0;
 const next = () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 4294967296; };
 const end = Math.floor(Date.now() / 1000 / at.step) * at.step;
 const bars = [];
 let price = 3800 + (seed % 100) / 10;
 for (let k = LIMIT - 1; k >= 0; k--) {
  const drift = Math.sin((k + seed % 37) / 14) * 0.9 + (next() - 0.5) * 6.4;
  const open = price;
  const close = Math.max(500, open + drift);
  const high = Math.max(open, close) + next() * 2.4;
  const low = Math.min(open, close) - next() * 2.4;
  bars.push({ time: end - k * at.step, open: round(open), high: round(high), low: round(low), close: round(close), volume: Math.round(800 + next() * 7200) });
  price = close;
 }
 return {
  source: 'sample',
  ...FEEDS.sample,
  ...sliced(bars),
  spread: null,
  note: 'No market source could be reached, so this is generated sample data — not a live quote.',
  asOf: Date.now(),
 };
}

// The bar under the crosshair, and the last one when the pointer is not over a bar.
function bar(candles, time) {
 return candles.find(candle => candle.time === time) || candles[candles.length - 1] || null;
}

// The four prices of a candle as the header shows them, to the cent.
function readout(candle) {
 return candle ? { open: round(candle.open), high: round(candle.high), low: round(candle.low), close: round(candle.close) } : null;
}

// technicalindicators returns values from the period's end onward; each is put back on the candle it belongs to. A
// moving average needs `period` closes and lands on the last of them; the RSI needs `period` changes, so it needs one
// close more and lands one candle later.
function plot(candles, values, from) {
 return values.map((value, index) => ({ time: candles[index + from].time, value: round(value) }));
}

function indicators(candles) {
 const closes = candles.map(candle => candle.close);
 const ma = SMA.calculate({ period: PERIODS.ma, values: closes });
 const sma = SMA.calculate({ period: PERIODS.sma, values: closes });
 const ema = EMA.calculate({ period: PERIODS.ema, values: closes });
 const rsi = RSI.calculate({ period: PERIODS.rsi, values: closes });
 return {
  ma: { period: PERIODS.ma, points: closes.length >= PERIODS.ma ? plot(candles, ma, PERIODS.ma - 1) : [] },
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
  for (const source of SOURCES) {
   const fetchFrom = source === 'yahoo' ? fromYahoo : source === 'binance' ? fromBinance : null;
   if (!fetchFrom || !supports(source, asked)) continue;
   try { data = await fetchFrom(asked); break; } catch (error) { trouble.push(`${source}: ${error.message || String(error)}`); }
  }
 }
 if (!data) {
  data = sample(asked);
  if (trouble.length) data.note = `${data.note} (${trouble.join('; ')})`;
 }
 return { ...data, interval: asked, supported: supported(data.source), indicators: indicators(data.candles) };
}

module.exports = { history, indicators, bar, readout, supports, plausible, FRAMES, INTERVALS, PERIODS, SOURCES, FEEDS };
