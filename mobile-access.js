(() => {
'use strict';

// The phone's way in, at the end of the sidebar's row. The server and the pairing live in the main process
// (desktop/mobile-companion.js); this is only the window that shows what the app says of it: the code a camera reads,
// the phone standing at the door waiting for the user's yes, and what is already connected.
//
// Opening the window offers a pairing code, which runs out after five minutes and is good for one phone only. While it
// is offered the button keeps its arcs lit; while a phone is connected they both stay lit and a mark stands at the
// corner of the icon, so the session shows without the window being opened.
const bridge = window.openghost?.mobile;
const SECOND = 1000, TICK = 1000;
const esc = text => String(text ?? '').replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]);

class MobileAccess {
 constructor({ button }) {
  Object.assign(this, { button, state: null, open: false, timer: 0, offered: 0 });
  if (!button) return;
  if (!bridge) { button.hidden = true; return; }
  this.dialog = document.querySelector('.mobile-access');
  const $ = selector => this.dialog.querySelector(selector);
  Object.assign(this, {
   qr: $('[data-mobile-qr]'),
   qrBox: $('[data-mobile-qr-box]'),
   empty: $('[data-mobile-empty]'),
   status: $('[data-mobile-status]'),
   ask: $('[data-mobile-ask]'),
   askWords: $('[data-mobile-ask-words]'),
   allow: $('[data-mobile-allow]'),
   deny: $('[data-mobile-deny]'),
   devices: $('[data-mobile-devices]'),
   warn: $('[data-mobile-warn]'),
   stop: $('[data-mobile-stop]'),
   again: $('[data-mobile-again]'),
   copy: $('[data-mobile-copy]'),
  });
  this.dialog.addEventListener('dismiss', () => this.close());
  this.dialog.addEventListener('close', () => this.conceal());
  this.dialog.addEventListener('cancel', event => {
   // Mid-transition of the theme a click lands outside the dialog and must not close it.
   if (event.target === this.dialog && !this.open) event.preventDefault();
  });
  button.addEventListener('mobile-open', () => this.toggle());
  this.allow.addEventListener('click', () => this.answer(true));
  this.deny.addEventListener('click', () => this.answer(false));
  this.stop.addEventListener('click', async () => {
   this.offered = 0;
   this.take(await bridge.unpair());
  });
  this.again.addEventListener('click', async () => this.take(await bridge.pair()));
  this.copy.addEventListener('click', () => this.copyLink());
  this.devices.addEventListener('click', event => {
   const row = event.target.closest('[data-device]');
   if (!row) return;
   const id = row.dataset.device;
   const ask = event.target.closest('[data-revoke]') ? bridge.revoke(id) : event.target.closest('[data-disconnect]') ? bridge.disconnect(id) : null;
   ask.then(state => state && this.take(state));
  });
  // Whatever the main process says of it — a phone came or went, the settings changed — is shown here at once.
  bridge.onChange?.(state => state && this.take(state));
  bridge.get?.().then(state => state && this.take(state)).catch(() => {});
 }

 toggle() { this.open ? this.close() : this.show(); }

 async show() {
  if (this.open) return;
  this.open = true;
  // The press that opened the window must not also be the press that closes it: `closedby=any` reads a click outside
  // the dialog, and the click on the icon is still on its way when the dialog appears. It is let finish first.
  await new Promise(resolve => setTimeout(resolve, 0));
  if (!this.open) return;
  this.dialog.showModal();
  // The code a phone reads is offered as the window opens; what was given up before is not brought back.
  this.take(await bridge.refresh().catch(() => null));
  this.timer = setInterval(() => this.tick(), TICK);
 }

 close() { this.dialog.close(); }

 conceal() {
  this.open = false;
  clearInterval(this.timer);
  this.timer = 0;
  this.button.focus?.();
 }

 // The offer is watched for its five minutes: when they are up the app offers another, so a phone that comes a moment
 // late still finds a code to read. A code that was stopped by hand is not brought back by the clock.
 tick() {
  if (!this.offered) return;
  const left = this.offered - Date.now();
  if (left <= -4000) {
   this.offered = Date.now() + 5 * 60 * 1000;
   bridge.refresh().then(state => state && this.take(state)).catch(() => {});
   return;
  }
  if (this.state) this.draw(this.state);
 }

 answer(yes) {
  const waiting = this.state?.waiting;
  if (!waiting) return;
  this.allow.disabled = this.deny.disabled = true;
  bridge.approve(waiting.id, yes).then(state => {
   this.allow.disabled = this.deny.disabled = false;
   if (state) this.take(state);
  }).catch(() => { this.allow.disabled = this.deny.disabled = false; });
 }

 async copyLink() {
  const wanted = this.state?.pairing ? this.state.qrText : this.state?.url;
  if (!wanted) return;
  if (await bridge.copy(wanted).catch(() => false)) this.flash(this.copy, I18n.t('mobile.copied'));
 }

 flash(node, words) {
  const was = node.textContent;
  node.textContent = words;
  clearTimeout(node._flash);
  node._flash = setTimeout(() => { node.textContent = was; }, 1600);
 }

 take(state) {
  this.state = state;
  this.button.toggleAttribute('active', !!state?.pairing || !!state?.running);
  this.button.toggleAttribute('connected', !!(state?.devices || []).some(device => device.online));
  if (state?.qrEnds) this.offered = state.qrEnds;
  if (this.open) this.draw(state);
 }

 draw(state) {
  if (!state) return;
  const running = !!state.running;
  // The white square is for a camera to read; with no code offered it is put away, and the line saying why stands in
  // the page's own colours instead.
  this.qrBox.hidden = !state.qr;
  if (state.qr) this.qr.src = state.qr;
  this.empty.hidden = !!state.qr;
  this.empty.textContent = state.qr
   ? ''
   : running
    ? I18n.t(state.pairing ? 'mobile.wait.code' : 'mobile.ready')
    : I18n.t('mobile.off');
  this.status.textContent = this.words(state);
  this.status.dataset.tone = state.waiting ? 'ask' : (state.devices || []).some(device => device.online) ? 'live' : running ? 'ready' : 'off';
  this.dialog.querySelector('.mobile-lead').hidden = !running;
  const waiting = state.waiting;
  this.ask.hidden = !waiting;
  if (waiting) {
   this.askWords.textContent = I18n.t('mobile.ask', { name: waiting.name || I18n.t('mobile.unknown'), address: waiting.address });
   this.askWords.title = waiting.model || '';
  }
  this.stop.disabled = !state.pairing;
  this.again.disabled = !running;
  this.copy.disabled = !running;
  this.drawDevices(state);
  const plain = (state.devices || []).some(device => device.online && !device.sealed);
  this.warn.hidden = !(plain || state.lan || state.error);
  this.warn.textContent = state.error
   || (plain ? I18n.t('mobile.warn.plain') : state.lan ? I18n.t('mobile.warn.lan') : '');
 }

 // One line per device the app has let in: what it is, when it was last here, and whether it is here now.
 drawDevices(state) {
  const devices = state.devices || [];
  this.devices.innerHTML = devices.length
   ? devices.map(device => `
    <li class="mobile-device${device.online ? ' is-online' : ''}" data-device="${esc(device.id)}">
     <span class="mobile-device-mark" aria-hidden="true"></span>
     <span class="mobile-device-name">${esc(device.name || device.id)}</span>
     <span class="mobile-device-when">${esc(this.when(device))}</span>
     ${device.online
      ? `<button type="button" class="mobile-quiet" data-disconnect>${esc(I18n.t('mobile.disconnect'))}</button>`
      : `<button type="button" class="mobile-quiet" data-revoke>${esc(I18n.t('mobile.revoke'))}</button>`}
    </li>`).join('')
   : `<li class="mobile-device is-none">${esc(I18n.t('mobile.devices.none'))}</li>`;
 }

 when({ online, lastSeen, lastAddress }) {
  if (online) return I18n.t('mobile.here');
  if (!lastSeen) return I18n.t('mobile.never');
  const minutes = Math.round((Date.now() - lastSeen) / 60000);
  const ago = minutes < 60
   ? I18n.t('mobile.ago.minutes', { n: Math.max(1, minutes) })
   : minutes < 24 * 60
    ? I18n.t('mobile.ago.hours', { n: Math.round(minutes / 60) })
    : I18n.t('mobile.ago.days', { n: Math.round(minutes / 1440) });
  return [ago, lastAddress].filter(Boolean).join(' · ');
 }

 words(state) {
  const online = (state.devices || []).filter(device => device.online);
  // The reason it is not listening is told under the code, not twice: here the line simply says off.
  if (state.error && state.running) return state.error;
  if (!state.running) return I18n.t('mobile.status.off');
  if (state.waiting) return I18n.t('mobile.status.ask');
  if (online.length) return I18n.t(online.length === 1 ? 'mobile.status.connected' : 'mobile.status.connected.many', { n: online.length });
  if (state.pairing) return I18n.t('mobile.status.waiting');
  return I18n.t('mobile.status.ready');
 }
}

window.MobileAccess = MobileAccess;
})();
