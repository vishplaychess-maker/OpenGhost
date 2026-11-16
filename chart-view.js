(() => {
'use strict';

// Trading Chart: a view over the whole window for one instrument, drawn with TradingView's Lightweight Charts. The
// candles, the moving averages and the RSI come from the main process (desktop/chart-data.js), which is where market
// data is reached because the page itself may reach only its model provider. The view names the source it drew, so a
// sample series can never pass for a quote; the spread is shown only where the source has a real bid and ask.
const FRAMES = ['1h', '4h', '1d'];
const SPACE = 10;
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

class ChartView {
 constructor() {
  this.interval = '1d';
  this.data = null;
  this.chart = null;
  this.parts = null;
  this.token = 0;
  this.root = this.build();
  document.body.append(this.root);
  document.addEventListener('keydown', event => {
   if (this.root.hidden) return;
   if (event.key === 'Escape') { event.preventDefault(); this.close(); }
  });
  document.addEventListener('keydown', event => {
   if (!(event.ctrlKey || event.metaKey) || !event.shiftKey || event.code !== 'KeyG') return;
   event.preventDefault();
   this.toggle();
  });
  if (window.Theme?.onChange) Theme.onChange(() => this.repaint());
  this.resize = new ResizeObserver(() => this.fit());
  this.resize.observe(this.stage);
 }

 build() {
  const root = document.createElement('div');
  root.className = 'chart-view';
  root.hidden = true;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-labelledby', 'chart-view-title');
  root.innerHTML = `
   <div class="chart-panel">
   <header class="chart-head">
    <div class="chart-brand">
     <span class="chart-title" id="chart-view-title">${I18n.t('chart.title')}</span>
     <span class="chart-source"><span class="chart-source-symbol"></span><span class="chart-source-name"></span></span>
    </div>
    <div class="chart-frames" role="group" aria-label="${I18n.t('chart.frame')}"></div>
    <span class="chart-spread" title=""></span>
    <button type="button" class="chart-close" aria-label="${I18n.t('chart.close')}">
     <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M3.5 3.5l7 7M10.5 3.5l-7 7"/></svg>
    </button>
   </header>
   <div class="chart-stage"></div>
   <footer class="chart-foot">
    <span class="chart-legend" aria-live="polite"></span>
    <span class="chart-note"></span>
   </footer>
   </div>`;
  this.stage = root.querySelector('.chart-stage');
  this.source = root.querySelector('.chart-source-symbol');
  this.sourceName = root.querySelector('.chart-source-name');
  this.spread = root.querySelector('.chart-spread');
  this.legend = root.querySelector('.chart-legend');
  this.note = root.querySelector('.chart-note');
  this.frames = root.querySelector('.chart-frames');
  for (const frame of FRAMES) {
   const button = document.createElement('button');
   button.type = 'button';
   button.className = 'chart-frame';
   button.dataset.frame = frame;
   button.textContent = frame;
   button.setAttribute('aria-pressed', String(frame === this.interval));
   button.addEventListener('click', () => this.frame(frame));
   this.frames.append(button);
  }
  root.querySelector('.chart-close').addEventListener('click', () => this.close());
  // A press on the scrim, away from the panel, closes the view; a press on it does not.
  root.addEventListener('pointerdown', event => { if (event.target === root) this.close(); });
  return root;
 }

 async open() {
  if (!this.root.hidden) return;
  this.root.hidden = false;
  this.root.removeAttribute('aria-hidden');
  if (!reducedMotion()) this.root.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180, easing: 'ease-out' });
  this.root.querySelector('.chart-close').focus({ preventScroll: true });
  await this.load();
 }

 close() {
  if (this.root.hidden) return;
  this.root.hidden = true;
  this.root.setAttribute('aria-hidden', 'true');
  this.destroy();
 }

 toggle() { this.root.hidden ? this.open() : this.close(); }

 async frame(next) {
  if (next === this.interval) return;
  this.interval = next;
  for (const button of this.frames.children) button.setAttribute('aria-pressed', String(button.dataset.frame === next));
  await this.load();
 }

 // One load at a time: an answer to a frame the person has already left is thrown away.
 async load() {
  const token = ++this.token;
  this.say(I18n.t('chart.loading'));
  const answer = await window.openghost?.chart?.history({ interval: this.interval }).catch(error => ({ error: error?.message || String(error) }));
  if (token !== this.token) return;
  if (!answer || answer.error) { this.say(I18n.t('chart.failed')); return; }
  this.data = answer;
  this.render();
 }

 // The chart is built again from the data in hand — cheaper than pruning series on every frame — and again when the
 // theme changes, because the colours it was drawn in are no longer the window's.
 repaint() { if (!this.root.hidden && this.data) this.render(); }

 render() {
  const data = this.data;
  const LWC = window.LightweightCharts;
  if (!LWC) { this.say(I18n.t('chart.failed')); return; }
  this.destroy();
  const colors = this.colors();
  this.chart = LWC.createChart(this.stage, {
   layout: { background: { type: 'solid', color: 'transparent' }, textColor: colors.text, fontFamily: getComputedStyle(document.body).fontFamily, attributionLogo: false },
   grid: { vertLines: { color: colors.grid }, horzLines: { color: colors.grid } },
   rightPriceScale: { borderColor: colors.edge, scaleMargins: { top: 0.08, bottom: 0.08 } },
   timeScale: { borderColor: colors.edge, timeVisible: data.interval !== '1d', secondsVisible: false, rightOffset: 3 },
   crosshair: { mode: LWC.CrosshairMode.Normal, vertLine: { color: colors.edge, labelBackgroundColor: colors.lift }, horzLine: { color: colors.edge, labelBackgroundColor: colors.lift } },
   localization: { priceFormatter: value => value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) },
   autoSize: false,
  });
  const candles = this.chart.addSeries(LWC.CandlestickSeries, {
   upColor: colors.up, downColor: colors.down, borderUpColor: colors.up, borderDownColor: colors.down,
   wickUpColor: colors.up, wickDownColor: colors.down, priceLineColor: colors.text,
  });
  candles.setData(data.candles);
  const sma = this.chart.addSeries(LWC.LineSeries, { color: colors.sma, lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
  sma.setData(data.indicators.sma.points);
  const ema = this.chart.addSeries(LWC.LineSeries, { color: colors.ema, lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
  ema.setData(data.indicators.ema.points);
  const rsi = this.chart.addSeries(LWC.LineSeries, { color: colors.rsi, lineWidth: 1, priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false, priceFormat: { type: 'price', precision: 0, minMove: 1 } }, 1);
  rsi.setData(data.indicators.rsi.points);
  rsi.createPriceLine?.({ price: 70, color: colors.edge, lineWidth: 1, lineStyle: LWC.LineStyle.Dotted, axisLabelVisible: false, title: '' });
  rsi.createPriceLine?.({ price: 30, color: colors.edge, lineWidth: 1, lineStyle: LWC.LineStyle.Dotted, axisLabelVisible: false, title: '' });
  // The RSI's own pane gets a name, so 70 and 30 are not read as gold prices.
  const panes = this.chart.panes?.() || [];
  panes[1]?.setHeight?.(120);

  // The spread rides on the last candle, when there is a real one to show: the difference between the bid and the ask
  // the source itself published a moment ago.
  if (data.spread) {
   const last = data.candles[data.candles.length - 1]?.time;
   if (last) LWC.createSeriesMarkers(candles, [{ time: last, position: 'aboveBar', color: colors.warn, shape: 'arrowDown', text: `${I18n.t('chart.spread')} $${data.spread.value.toFixed(2)}` }]);
  }
  this.parts = { candles, sma, ema, rsi };
  this.source.textContent = data.symbol;
  this.sourceName.textContent = data.label;
  this.spread.textContent = data.spread
   ? `${I18n.t('chart.spread')} $${data.spread.value.toFixed(2)} · ${data.spread.bid.toFixed(2)} / ${data.spread.ask.toFixed(2)}`
   : `${I18n.t('chart.spread')} —`;
  this.spread.title = data.spread ? I18n.t('chart.spread.note') : I18n.t('chart.spread.none');
  this.spread.classList.toggle('is-bare', !data.spread);
  this.legend.textContent = this.words(data);
  this.note.textContent = data.note || '';
  this.fit();
 }

 // The line under the chart: what each line is and what it reads at the last candle.
 words(data) {
  const tail = points => points.length ? points[points.length - 1].value : null;
  const value = number => number == null ? '—' : Number(number).toLocaleString('en-US', { maximumFractionDigits: 2 });
  return [
   `SMA ${data.indicators.sma.period}: ${value(tail(data.indicators.sma.points))}`,
   `EMA ${data.indicators.ema.period}: ${value(tail(data.indicators.ema.points))}`,
   `RSI ${data.indicators.rsi.period}: ${value(tail(data.indicators.rsi.points))}`,
  ].join('   ');
 }

 // The window's own colours, read at the moment of drawing, which is what makes both themes and a theme switch work.
 colors() {
  const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const rgba = (name, alpha) => `rgba(${css(name) || '255,255,255'}, ${alpha})`;
  return {
   text: rgba('--fg-rgb', 0.62),
   grid: rgba('--fg-rgb', 0.06),
   edge: rgba('--fg-rgb', 0.16),
   lift: rgba('--fg-rgb', 0.3),
   up: `rgb(${css('--success-rgb') || '110, 205, 140'})`,
   down: `rgb(${css('--danger-rgb') || '255, 115, 105'})`,
   sma: `rgb(${css('--link-rgb') || '140, 190, 255'})`,
   ema: `rgb(${css('--warn-rgb') || '255, 180, 96'})`,
   warn: `rgb(${css('--warn-rgb') || '255, 180, 96'})`,
   rsi: rgba('--fg-rgb', 0.75),
  };
 }

 fit() {
  if (!this.chart) return;
  const width = Math.max(320, this.stage.clientWidth), height = Math.max(240, this.stage.clientHeight);
  this.chart.applyOptions({ width, height });
  this.chart.timeScale().fitContent();
 }

 destroy() {
  if (this.chart) { try { this.chart.remove(); } catch {} }
  this.chart = null;
  this.parts = null;
 }

 say(text) { this.note.textContent = text; }
}

window.ChartView = ChartView;
})();
