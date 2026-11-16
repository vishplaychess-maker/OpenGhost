(() => {
'use strict';

// Trading Chart: a view over the whole window for one instrument, drawn with TradingView's Lightweight Charts. The
// candles, the volume and the indicators come from the main process (desktop/chart-data.js), which is where market
// data is reached because the page itself may reach only its model provider. The view names the exact feed it drew —
// futures, a tokenized proxy or a sample — so none can pass for another; a bid/ask strip is shown only where the
// source itself publishes a book, and reads "—" where it does not.
const FRAMES = [['1m', '1m'], ['5m', '5m'], ['15m', '15m'], ['30m', '30m'], ['1h', '1H'], ['4h', '4h'], ['1d', '1D'], ['1wk', '1W'], ['1mo', '1M']];
const INTRADAY = new Set(['1m', '5m', '15m', '30m', '1h', '4h']);
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

class ChartView {
 constructor() {
  this.interval = '1d';
  this.data = null;
  this.chart = null;
  this.parts = null;
  this.token = 0;
  this.maps = null;
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
    <span class="chart-spread"></span>
    <button type="button" class="chart-close" aria-label="${I18n.t('chart.close')}">
     <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M3.5 3.5l7 7M10.5 3.5l-7 7"/></svg>
    </button>
   </header>
   <div class="chart-ohlc">
    <span class="chart-ohlc-item"><span class="chart-ohlc-key">O</span><span class="chart-ohlc-value" data-price="open">—</span></span>
    <span class="chart-ohlc-item"><span class="chart-ohlc-key">H</span><span class="chart-ohlc-value" data-price="high">—</span></span>
    <span class="chart-ohlc-item"><span class="chart-ohlc-key">L</span><span class="chart-ohlc-value" data-price="low">—</span></span>
    <span class="chart-ohlc-item"><span class="chart-ohlc-key">C</span><span class="chart-ohlc-value" data-price="close">—</span></span>
   </div>
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
  this.ohlc = Object.fromEntries(['open', 'high', 'low', 'close'].map(key => [key, root.querySelector(`[data-price="${key}"]`)]));
  for (const [frame, text] of FRAMES) {
   const button = document.createElement('button');
   button.type = 'button';
   button.className = 'chart-frame';
   button.dataset.frame = frame;
   button.textContent = text;
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
   timeScale: { borderColor: colors.edge, timeVisible: INTRADAY.has(data.interval), secondsVisible: false, rightOffset: 3 },
   crosshair: { mode: LWC.CrosshairMode.Normal, vertLine: { color: colors.edge, labelBackgroundColor: colors.lift }, horzLine: { color: colors.edge, labelBackgroundColor: colors.lift } },
   localization: { priceFormatter: value => this.price(value) },
   autoSize: false,
  });
  const candles = this.chart.addSeries(LWC.CandlestickSeries, {
   upColor: colors.up, downColor: colors.down, borderUpColor: colors.up, borderDownColor: colors.down,
   wickUpColor: colors.up, wickDownColor: colors.down, priceLineColor: colors.text,
  });
  candles.setData(data.candles);
  const ma = this.chart.addSeries(LWC.LineSeries, { color: colors.ma, lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
  ma.setData(data.indicators.ma.points);
  const sma = this.chart.addSeries(LWC.LineSeries, { color: colors.sma, lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
  sma.setData(data.indicators.sma.points);
  const ema = this.chart.addSeries(LWC.LineSeries, { color: colors.ema, lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
  ema.setData(data.indicators.ema.points);
  // Volume stands in its own pane under the candles, coloured by the bar it belongs to, never scaled onto the price axis.
  const volume = this.chart.addSeries(LWC.HistogramSeries, { priceFormat: { type: 'volume' }, priceLineVisible: false, lastValueVisible: false }, 1);
  volume.setData(data.volume.map((bar, index) => ({ time: bar.time, value: bar.value, color: data.candles[index].close >= data.candles[index].open ? colors.volumeUp : colors.volumeDown })));
  volume.priceScale?.().applyOptions?.({ scaleMargins: { top: 0.18, bottom: 0 } });
  const rsi = this.chart.addSeries(LWC.LineSeries, { color: colors.rsi, lineWidth: 1, priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false, priceFormat: { type: 'price', precision: 0, minMove: 1 } }, 2);
  rsi.setData(data.indicators.rsi.points);
  rsi.createPriceLine?.({ price: 70, color: colors.edge, lineWidth: 1, lineStyle: LWC.LineStyle.Dotted, axisLabelVisible: false, title: '' });
  rsi.createPriceLine?.({ price: 30, color: colors.edge, lineWidth: 1, lineStyle: LWC.LineStyle.Dotted, axisLabelVisible: false, title: '' });
  // The volume's pane stays shallow; the RSI's names its own range, so 70 and 30 are not read as gold prices.
  const panes = this.chart.panes?.() || [];
  panes[1]?.setHeight?.(76);
  panes[2]?.setHeight?.(96);

  // The spread rides on the last candle only where the source itself published a bid and ask a moment ago.
  if (data.spread) {
   const last = data.candles[data.candles.length - 1]?.time;
   if (last) LWC.createSeriesMarkers(candles, [{ time: last, position: 'aboveBar', color: colors.warn, shape: 'arrowDown', text: `${I18n.t('chart.spread')} $${data.spread.value.toFixed(2)}` }]);
  }
  this.parts = { candles, ma, sma, ema, volume, rsi };
  this.maps = Object.fromEntries(['ma', 'sma', 'ema', 'rsi'].map(key => [key, new Map(data.indicators[key].points.map(point => [point.time, point.value]))]));
  this.source.textContent = data.symbol;
  this.sourceName.textContent = `${data.label} · ${this.frameText(data.interval)}`;
  this.showBook(data.spread);
  this.paintFrames();
  this.showBar(data.candles[data.candles.length - 1]);
  this.note.textContent = data.note || '';
  // The header follows the crosshair: the bar under it, or the newest bar once the pointer is away.
  this.chart.subscribeCrosshairMove(param => {
   const hovered = param?.time ? (param.seriesData?.get(candles) || data.candles.find(candle => candle.time === param.time)) : null;
   this.showBar(hovered || data.candles[data.candles.length - 1]);
  });
  this.fit();
 }

 // The line under the chart: what each line is and what it reads where the crosshair stands, or at the newest bar.
 words(time) {
  const value = key => {
   const read = this.maps?.[key]?.get(time);
   return read == null ? '—' : this.price(read);
  };
  return [
   `MA ${this.data.indicators.ma.period} close: ${value('ma')}`,
   `SMA ${this.data.indicators.sma.period}: ${value('sma')}`,
   `EMA ${this.data.indicators.ema.period}: ${value('ema')}`,
   `RSI ${this.data.indicators.rsi.period}: ${this.maps?.rsi?.get(time) == null ? '—' : this.maps.rsi.get(time).toFixed(1)}`,
  ].join('   ');
 }

 // The OHLC header: four prices of one bar, or "—" when there is no bar at all.
 showBar(candle) {
  if (!candle) {
   for (const key of Object.keys(this.ohlc)) this.ohlc[key].textContent = '—';
   this.legend.textContent = this.words(null);
   return;
  }
  for (const key of Object.keys(this.ohlc)) this.ohlc[key].textContent = this.price(candle[key]);
  this.legend.textContent = this.words(candle.time);
 }

 // Bid, ask and the spread between them, from the source's own book; "—" for every part a source does not publish.
 showBook(spread) {
  const piece = (key, value) => `<span class="chart-book-key">${I18n.t(key)}</span><span class="chart-book-value">${value}</span>`;
  this.spread.innerHTML = [
   piece('chart.bid', spread ? this.price(spread.bid) : '—'),
   piece('chart.ask', spread ? this.price(spread.ask) : '—'),
   piece('chart.spread', spread ? `$${spread.value.toFixed(2)}` : '—'),
  ].map(part => `<span class="chart-book-piece">${part}</span>`).join('');
  this.spread.title = spread ? I18n.t('chart.spread.note') : I18n.t('chart.spread.none');
  this.spread.classList.toggle('is-bare', !spread);
 }

 // A frame the drawn source cannot answer is disabled, never faked from another frame.
 paintFrames() {
  const ok = this.data?.supported || [];
  for (const button of this.frames.children) {
   const usable = ok.includes(button.dataset.frame);
   button.disabled = !usable;
   button.title = usable ? '' : I18n.t('chart.frame.none');
  }
 }

 frameText(frame) { return (FRAMES.find(([key]) => key === frame) || [frame, frame])[1]; }

 price(value) {
  return Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
   volumeUp: rgba('--success-rgb', 0.45),
   volumeDown: rgba('--danger-rgb', 0.45),
   ma: 'rgba(186, 156, 255, 0.95)',
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
  this.maps = null;
 }

 say(text) { this.note.textContent = text; }
}

window.ChartView = ChartView;
})();
