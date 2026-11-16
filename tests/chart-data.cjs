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

(async () => {
  const sample = await chart.history({ interval: '1d', offline: true });
  check('the sample names itself and says it is not a quote', sample.source === 'sample' && /not a live quote/i.test(sample.label) && /generated sample data/.test(sample.note));
  check('the sample shows no spread, because there is none to show', sample.spread === null);
  check('the sample holds the asked-for number of candles in order', sample.candles.length === 300 && sample.candles.every((candle, k) => k === 0 || candle.time > sample.candles[k - 1].time));
  check('every sample candle obeys high ≥ max(open, close) and low ≤ min(open, close)', sample.candles.every(candle => candle.high >= Math.max(candle.open, candle.close) && candle.low <= Math.min(candle.open, candle.close)));
  const again = await chart.history({ interval: '1d', offline: true });
  check('the sample is the same on a second call', JSON.stringify(again.candles) === JSON.stringify(sample.candles));

  for (const interval of ['1h', '4h', '1d']) {
    const data = await chart.history({ interval, offline: true });
    check(interval + ': the view gets candles, indicators and its own interval back', data.interval === interval && data.candles.length > 50 && data.indicators.sma.points.length > 0 && data.indicators.rsi.points.length > 0);
  }
  const unknown = await chart.history({ interval: 'nonsense', offline: true });
  check('an interval the view does not offer falls back to the daily one', unknown.interval === '1d');
  console.log(`\n${count} checks passed`);
})().catch(error => { console.error(error); process.exitCode = 1; });
