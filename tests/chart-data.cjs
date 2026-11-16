'use strict';
// The Trading Chart's numbers, without a network: the indicator alignment over a known series, the sample generator's
// invariants, and what the view may and may not claim about a spread.
const assert = require('node:assert/strict');
const chart = require('../desktop/chart-data.js');
let count = 0;
const check = (name, value) => { assert.ok(value, name); count++; console.log('ok  ' + name); };

// A straight ramp makes every average checkable by hand.
const candles = Array.from({ length: 80 }, (_, k) => ({ time: 1700000000 + k * 86400, open: 100 + k, high: 101.5 + k, low: 99 + k, close: 100 + k }));
const marks = chart.indicators(candles);

check('SMA of a ramp starts only once its period is complete', marks.sma.points.length === candles.length - chart.PERIODS.sma + 1);
check('each SMA point stands on the candle whose window it averages', marks.sma.points[0].time === candles[chart.PERIODS.sma - 1].time && marks.sma.points.at(-1).time === candles.at(-1).time);
check('the first SMA over 100…119 is 109.5', marks.sma.points[0].value === 109.5);
check('EMA is as long as its window allows', marks.ema.points.length === candles.length - chart.PERIODS.ema + 1);
 check('RSI starts one candle later than the averages, because it counts changes', marks.rsi.points.length === candles.length - chart.PERIODS.rsi && marks.rsi.points[0].time === candles[chart.PERIODS.rsi].time);
check('RSI of a rising ramp is at its top', marks.rsi.points.at(-1).value === 100);
check('MA(9) close lands on the ninth candle, the average of the first nine closes', marks.ma.period === 9 && marks.ma.points[0].time === candles[8].time && marks.ma.points[0].value === 104);

// The broker-terminal frames, and which feed answers each: pinned to what the feeds were measured to return from this machine.
check('the view offers the nine frames of a broker terminal', chart.FRAMES.join() === '1m,5m,15m,30m,1h,4h,1d,1wk,1mo');
check('every frame maps to both keyless feeds and to a Yahoo range', chart.FRAMES.every(frame => chart.INTERVALS[frame]?.yahoo && chart.INTERVALS[frame]?.binance && chart.INTERVALS[frame]?.range));
check('Yahoo is asked within the ranges it measured: 7 days at 1m, 60 days at 5–30m, two years at 1h and 4h',
  chart.INTERVALS['1m'].range === '7d' && chart.INTERVALS['5m'].range === '60d' && chart.INTERVALS['15m'].range === '60d'
  && chart.INTERVALS['30m'].range === '60d' && chart.INTERVALS['1h'].range === '2y' && chart.INTERVALS['4h'].range === '2y');
check('a source is used for exactly the frames it maps, never a made-up one',
  chart.supports('yahoo', '15m') && chart.supports('binance', '1mo') && !chart.supports('yahoo', '2h') && !chart.supports('binance', '3h'));
check('real gold is asked for before the tokenized proxy, and the sample stands last',
  chart.SOURCES.join() === 'yahoo,binance,sample');
check('the sample can draw every frame, since it invents its own bars', chart.FRAMES.every(frame => chart.supports('sample', frame)));

// The header names the exact feed drawn, never a bare claim of XAU/USD.
const feeds = Object.entries(chart.FEEDS);
check('the futures feed names GC=F, COMEX and Yahoo', /GC=F/.test(chart.FEEDS.yahoo.symbol) && /COMEX/.test(chart.FEEDS.yahoo.label) && /futures/i.test(chart.FEEDS.yahoo.label) && /Yahoo/.test(chart.FEEDS.yahoo.label));
check('the proxy feed says PAXG, Binance and that it is a proxy', /PAXG/.test(chart.FEEDS.binance.symbol) && /Binance/.test(chart.FEEDS.binance.label) && /proxy/i.test(chart.FEEDS.binance.label));
check('the sample says it is not a live quote', /not a live quote/i.test(chart.FEEDS.sample.label));
check('no feed label is a bare XAU/USD claim', feeds.every(([, feed]) => !/^(XAU\/?USD|XAUUSD)( spot)?$/i.test(feed.label.trim()) && !/^(XAU\/?USD|XAUUSD)$/i.test(feed.symbol.trim())));

// The OHLC header: the bar under the crosshair, and the last bar when the pointer is not over one.
const hovered = chart.readout(candles[3]);
check('the OHLC readout is the hovered candle, to the cent', hovered.open === 103 && hovered.high === 104.5 && hovered.low === 102 && hovered.close === 103);
check('the crosshair’s bar is found by its time, and the last bar stands when the time is not a bar', chart.bar(candles, candles[3].time)?.time === candles[3].time && chart.bar(candles, 1)?.time === candles.at(-1).time);
const cent = chart.readout({ open: 3873.644, high: 3873.756, low: 3867.454, close: 3870.284 });
check('prices are read to two places', cent.open === 3873.64 && cent.high === 3873.76 && cent.low === 3867.45 && cent.close === 3870.28);
// One answer can disagree with itself: a series whose last bar sits far from the market price the same answer names is
// not this instrument today, and is refused rather than drawn.
check('a series that agrees with its own quote is taken', chart.plausible(3880.5, 3881.4));
check('a series whose last bar is 17% away from its own quote is refused', !chart.plausible(4535.3, 3881.4));
check('a quote the answer does not carry cannot condemn its series', chart.plausible(3880.5, null) && chart.plausible(3880.5, undefined));

(async () => {
  const sample = await chart.history({ interval: '1d', offline: true });
  check('the sample names itself and says it is not a quote', sample.source === 'sample' && /not a live quote/i.test(sample.label) && /generated sample data/.test(sample.note));
  check('the sample shows no spread, because there is none to show', sample.spread === null);
  check('the sample holds the asked-for number of candles in order', sample.candles.length === 300 && sample.candles.every((candle, k) => k === 0 || candle.time > sample.candles[k - 1].time));
  check('every sample candle obeys high ≥ max(open, close) and low ≤ min(open, close)', sample.candles.every(candle => candle.high >= Math.max(candle.open, candle.close) && candle.low <= Math.min(candle.open, candle.close)));
  check('the sample’s volume stands on the same bars as its candles', sample.volume.length === sample.candles.length && sample.volume.every((bar, k) => bar.time === sample.candles[k].time && bar.value >= 0));
  check('the sample says which frames it can draw', Array.isArray(sample.supported) && sample.supported.length === chart.FRAMES.length);
  const again = await chart.history({ interval: '1d', offline: true });
  check('the sample is the same on a second call', JSON.stringify(again.candles) === JSON.stringify(sample.candles));

  for (const interval of chart.FRAMES) {
    const data = await chart.history({ interval, offline: true });
    check(interval + ': the view gets candles, indicators, volume on the same bars and its own interval back',
      data.interval === interval && data.candles.length > 50 && data.indicators.sma.points.length > 0 && data.indicators.rsi.points.length > 0
      && data.indicators.ma.points.length === data.candles.length - 8
      && data.volume.length === data.candles.length && data.volume.every((bar, k) => bar.time === data.candles[k].time));
  }
  const unknown = await chart.history({ interval: 'nonsense', offline: true });
  check('an interval the view does not offer falls back to the daily one', unknown.interval === '1d');
  console.log(`\n${count} checks passed`);
})().catch(error => { console.error(error); process.exitCode = 1; });
