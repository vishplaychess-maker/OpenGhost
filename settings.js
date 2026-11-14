(() => {
'use strict';

const STORAGE = { effort: 'deepseek.effort', mode: 'openghost.mode', model: 'openghost.model', catalog: 'openghost.catalog', free: 'openghost.freeOnly', fallback: 'openghost.fallbackModel' };
const KEYS = { openai: 'openai.apiKey', anthropic: 'anthropic.apiKey', deepseek: 'deepseek.apiKey', openrouter: 'openrouter.apiKey', nvidia: 'nvidia.apiKey', gemini: 'gemini.apiKey', venice: 'venice.apiKey', iteracompute: 'iteracompute.apiKey', zro: 'zro.apiKey', infron: 'infron.apiKey', tokenharbor: 'tokenharbor.apiKey', yeta: 'yeta.apiKey', wusrouter: 'wusrouter.apiKey', coarena: 'coarena.apiKey', nararouter: 'nararouter.apiKey', crowllm: 'crowllm.apiKey', local: 'local.address', custom: 'custom.apiKey' };
// The order providers appear in, in the settings and in the model picker.
const ORDER = ['chatgpt', 'openai', 'grok', 'iteracompute', 'zro', 'infron', 'tokenharbor', 'yeta', 'wusrouter', 'coarena', 'nararouter', 'crowllm', 'anthropic', 'deepseek', 'openrouter', 'nvidia', 'gemini', 'venice', 'local', 'custom'];
// The providers a plan pays for: reached by signing in, with no key and no field to type one into.
const ACCOUNTS = ['chatgpt', 'grok'];
// The provider the app starts with: the settings ask for its key when nothing is connected, and new chats take its first
// model until the user picks another.
const FIRST_PROVIDER = 'deepseek';
const EFFORTS = ['none', 'low', 'high', 'max'];
const DEFAULT_EFFORT = 'high';
const DEFAULT_CONTEXT = 1000000;
// How long a provider's list of models counts as fresh. Opening the model picker after that reads the lists again.
const FRESH = 10 * 60 * 1000;
const LINKS = {
 openai: ['https://platform.openai.com/api-keys', 'platform.openai.com'],
 anthropic: ['https://console.anthropic.com/settings/keys', 'console.anthropic.com'],
 deepseek: ['https://platform.deepseek.com/api_keys', 'platform.deepseek.com'],
 openrouter: ['https://openrouter.ai/keys', 'openrouter.ai'],
 nvidia: ['https://build.nvidia.com/explore/discover', 'build.nvidia.com'],
 gemini: ['https://aistudio.google.com/app/apikey', 'aistudio.google.com'],
 venice: ['https://venice.ai/settings/api', 'venice.ai'],
 iteracompute: ['https://iteracompute.com/free/', 'iteracompute.com'],
 zro: ['https://zro.moonmath.ai/', 'zro.moonmath.ai'],
 infron: ['https://infron.ai/', 'infron.ai'],
 tokenharbor: ['https://tokenharbor.ai/', 'tokenharbor.ai'],
 yeta: ['https://platform.yeta.ai/', 'platform.yeta.ai'],
 wusrouter: ['https://wusrouter.com/', 'wusrouter.com'],
 coarena: ['https://coarena.ai/account/api/keys', 'coarena.ai'],
 nararouter: ['https://router.bynara.id/keys', 'router.bynara.id'],
 crowllm: ['https://crowllm.com/sign-up', 'crowllm.com'],
};
// What the user may write in by hand where a provider's own word is not enough. `models`: names of models its list
// does not hold. `context`: the size of the window, for the providers whose servers may not tell it. `address`: where a
// service lives, for the one that is reached by address and not only by key.
const HAND = {
 openai: { models: 'openai.models' },
 anthropic: { models: 'anthropic.models' },
 nvidia: { models: 'nvidia.models' },
 gemini: { models: 'gemini.models' },
 venice: { models: 'venice.models' },
 iteracompute: { models: 'iteracompute.models' },
 zro: { models: 'zro.models' },
 infron: { models: 'infron.models' },
 tokenharbor: { models: 'tokenharbor.models' },
 yeta: { models: 'yeta.models' },
 wusrouter: { models: 'wusrouter.models' },
 coarena: { models: 'coarena.models' },
 nararouter: { models: 'nararouter.models' },
 crowllm: { models: 'crowllm.models' },
 local: { models: 'local.models', context: 'local.context' },
 custom: { models: 'custom.models', context: 'custom.context', address: 'custom.address' },
};
// A local server stands where a key would: its address is kept as one. `window`: the window a model is taken to have
// when neither the server nor the user says.
const LOCAL = { window: 32768, presets: [['Ollama', 'http://localhost:11434'], ['LM Studio', 'http://localhost:1234']] };
// The providers reached by an address the user gives.
const SERVED = new Set(['local', 'custom']);
const PLACEHOLDERS = { anthropic: 'sk-ant-…', openrouter: 'sk-or-…', nvidia: 'nvapi-…', gemini: 'AIza…', venice: 'vapi_…', tokenharbor: 'thk_live_…', coarena: 'coa_…', nararouter: 'sk-nry-…', crowllm: 'sk-crow-…' };
const MODES = ['ask', 'auto', 'full'];
const DEFAULT_MODE = 'ask';
const CHECK_DELAY = 400;
const PAGE = { duration: 460, easing: 'cubic-bezier(0.32, 0.72, 0, 1)' };

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const escapeHtml = text => String(text).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const checking = provider => I18n.t(I18n.has(`settings.${provider}.checking`) ? `settings.${provider}.checking` : 'settings.key.checking');

function keyRow(provider) {
 const [href, host] = LINKS[provider];
 const note = I18n.has(`settings.${provider}.note`) ? ` ${escapeHtml(I18n.t(`settings.${provider}.note`))}` : '';
 return `
  <div class="settings-row">
   <div class="settings-text">
    <label class="settings-label" for="settings-key-${provider}">${escapeHtml(I18n.t(`settings.${provider}.key`))}</label>
    <p class="settings-hint"><span>${escapeHtml(I18n.t(`settings.${provider}.hint`))}</span> <a href="${href}" target="_blank" rel="noopener noreferrer">${host}</a>.${note}</p>
   </div>
   <div class="settings-control">
    <div class="settings-key-box">
     <input id="settings-key-${provider}" class="settings-key" data-provider="${provider}" type="password" placeholder="${PLACEHOLDERS[provider] || 'sk-…'}" autocomplete="off" spellcheck="false">
     <button type="button" class="settings-key-eye" aria-label="${escapeHtml(I18n.t('settings.key.show'))}" aria-pressed="false">${Glyphs.eye}</button>
    </div>
    <p class="settings-status" data-provider="${provider}" role="status"></p>
   </div>
  </div>`;
}

// A field for what is written by hand: a model's name, the size of a window, an address.
function handRow(provider, name, placeholder, extra = '') {
 const t = key => escapeHtml(I18n.t(`settings.${provider}.${key}`));
 return `
  <div class="settings-row">
   <div class="settings-text">
    <label class="settings-label" for="settings-${provider}-${name}">${t(name)}</label>
    <p class="settings-hint">${t(`${name}.hint`)}</p>
   </div>
   <div class="settings-control">
    <input id="settings-${provider}-${name}" class="settings-key settings-field" data-hand="${provider}.${name}" type="text" placeholder="${placeholder}" autocomplete="off" spellcheck="false">${extra}
   </div>
  </div>`;
}

function localRows() {
 const t = name => escapeHtml(I18n.t(`settings.local.${name}`));
 return `
  <div class="settings-row">
   <div class="settings-text">
    <label class="settings-label" for="settings-key-local">${t('key')}</label>
    <p class="settings-hint">${t('hint')}</p>
   </div>
   <div class="settings-control">
    <div class="settings-key-box">
     <input id="settings-key-local" class="settings-key settings-field" data-provider="local" type="text" placeholder="${LOCAL.presets[0][1]}" autocomplete="off" spellcheck="false">
    </div>
    <div class="settings-presets">${LOCAL.presets.map(([name, address]) => `<button type="button" class="settings-preset" data-address="${address}">${name}</button>`).join('')}</div>
    <p class="settings-status" data-provider="local" role="status"></p>
   </div>
  </div>${handRow('local', 'models', 'my-model')}${handRow('local', 'context', String(LOCAL.window))}`;
}

// A service that speaks the OpenAI API: where it lives, the key it asks for if it asks for one, and by hand what it
// does not tell.
function customRows() {
 const t = name => escapeHtml(I18n.t(`settings.custom.${name}`));
 return `${handRow('custom', 'address', 'https://api.example.com/v1', '\n    <p class="settings-status" data-provider="custom" role="status"></p>')}
  <div class="settings-row">
   <div class="settings-text">
    <label class="settings-label" for="settings-key-custom">${t('key')}</label>
    <p class="settings-hint">${t('hint')}</p>
   </div>
   <div class="settings-control">
    <div class="settings-key-box">
     <input id="settings-key-custom" class="settings-key" data-provider="custom" type="password" placeholder="sk-…" autocomplete="off" spellcheck="false">
     <button type="button" class="settings-key-eye" aria-label="${escapeHtml(I18n.t('settings.key.show'))}" aria-pressed="false">${Glyphs.eye}</button>
    </div>
   </div>
  </div>${handRow('custom', 'models', 'model-id')}${handRow('custom', 'context', String(LOCAL.window))}`;
}

// The Telegram bot (desktop/telegram.js keeps it): the token BotFather gives, the user ids it may answer, and the switch
// that lets it run. Its status line says whether it is on the air and under which name.
function telegramRows() {
 const t = name => escapeHtml(I18n.t(`settings.telegram.${name}`));
 return `
  <div class="settings-row">
   <div class="settings-text">
    <label class="settings-label" for="settings-telegram-token">${t('token')}</label>
    <p class="settings-hint"><span>${t('token.hint')}</span> <a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer">t.me/BotFather</a></p>
   </div>
   <div class="settings-control">
    <div class="settings-key-box">
     <input id="settings-telegram-token" class="settings-key settings-field" data-telegram="token" type="password" placeholder="123456789:AA…" autocomplete="off" spellcheck="false">
     <button type="button" class="settings-key-eye" aria-label="${escapeHtml(I18n.t('settings.key.show'))}" aria-pressed="false">${Glyphs.eye}</button>
    </div>
   </div>
  </div>
  <div class="settings-row">
   <div class="settings-text">
    <label class="settings-label" for="settings-telegram-allowed">${t('allowed')}</label>
    <p class="settings-hint">${t('allowed.hint')}</p>
   </div>
   <div class="settings-control">
    <input id="settings-telegram-allowed" class="settings-key settings-field" data-telegram="allowed" type="text" placeholder="123456789, 987654321" autocomplete="off" spellcheck="false">
   </div>
  </div>
  <div class="settings-row">
   <div class="settings-text">
    <span class="settings-label" id="settings-telegram-enabled-label">${t('enabled')}</span>
    <p class="settings-hint">${t('enabled.hint')}</p>
   </div>
   <div class="settings-control">
    <button type="button" id="settings-telegram-enabled" class="memory-switch telegram-switch" role="switch" aria-checked="false" aria-labelledby="settings-telegram-enabled-label"><span class="memory-switch-knob"></span></button>
    <p class="settings-status" data-telegram-status role="status"></p>
   </div>
  </div>`;
}

// The WhatsApp account (desktop/whatsapp.js keeps it): the numbers it may answer, the switch that lets it run, and the
// QR code to scan while linking. Its status line says whether it is connected, waiting for a scan, or reconnecting.
function whatsappRows() {
 const t = name => escapeHtml(I18n.t(`settings.whatsapp.${name}`));
 return `
  <div class="settings-row">
   <div class="settings-text">
    <span class="settings-label">${t('qr')}</span>
    <p class="settings-hint">${t('qr.hint')}</p>
   </div>
   <div class="settings-control settings-whatsapp-qr">
    <img class="whatsapp-qr" data-whatsapp-qr alt="${t('qr')}" hidden>
    <p class="settings-status" data-whatsapp-qr-status role="status"></p>
   </div>
  </div>
  <div class="settings-row">
   <div class="settings-text">
    <label class="settings-label" for="settings-whatsapp-allowed">${t('allowed')}</label>
    <p class="settings-hint">${t('allowed.hint')}</p>
   </div>
   <div class="settings-control">
    <input id="settings-whatsapp-allowed" class="settings-key settings-field" data-whatsapp="allowed" type="text" placeholder="919876543210, 447700900123" autocomplete="off" spellcheck="false">
   </div>
  </div>
  <div class="settings-row">
   <div class="settings-text">
    <span class="settings-label" id="settings-whatsapp-enabled-label">${t('enabled')}</span>
    <p class="settings-hint">${t('enabled.hint')}</p>
   </div>
   <div class="settings-control">
    <button type="button" id="settings-whatsapp-enabled" class="memory-switch whatsapp-switch" role="switch" aria-checked="false" aria-labelledby="settings-whatsapp-enabled-label"><span class="memory-switch-knob"></span></button>
    <p class="settings-status" data-whatsapp-status role="status"></p>
   </div>
  </div>`;
}

// Phone access (desktop/mobile-companion.js keeps the server): the switch that lets a phone in, the address it opens,
// whether a phone on the Wi-Fi may reach it, whether it may see the screen, the port, and the phones already paired.
function mobileRows() {
 const t = name => escapeHtml(I18n.t(`settings.mobile.${name}`));
 const switchRow = (name, hint) => `
  <div class="settings-row">
   <div class="settings-text">
    <span class="settings-label" id="settings-mobile-${name}-label">${t(name)}</span>
    <p class="settings-hint">${hint}</p>
   </div>
   <div class="settings-control">
    <button type="button" id="settings-mobile-${name}" class="memory-switch mobile-switch" role="switch" data-mobile="${name}" aria-checked="false" aria-labelledby="settings-mobile-${name}-label"><span class="memory-switch-knob"></span></button>
   </div>
  </div>`;
 return `
  ${switchRow('enabled', t('enabled.hint'))}
  <div class="settings-row">
   <div class="settings-text">
    <span class="settings-label">${t('address')}</span>
    <p class="settings-hint">${t('qr.hint')}</p>
   </div>
   <div class="settings-control settings-mobile-control">
    <code class="settings-mobile-url" data-mobile-url></code>
    <button type="button" class="settings-button" data-mobile-pair>${t('qr')}</button>
    <p class="settings-status" data-mobile-status role="status"></p>
   </div>
  </div>
  ${switchRow('lan', t('lan.hint'))}
  ${switchRow('screens', t('screens.hint'))}
  <div class="settings-row">
   <div class="settings-text">
    <label class="settings-label" for="settings-mobile-port">${t('port')}</label>
    <p class="settings-hint">${t('port.hint')}</p>
   </div>
   <div class="settings-control">
    <input id="settings-mobile-port" class="settings-key settings-field" data-mobile="port" type="text" placeholder="${t('port.auto')}" autocomplete="off" spellcheck="false" inputmode="numeric">
   </div>
  </div>
  <div class="settings-row">
   <div class="settings-text">
    <span class="settings-label">${t('devices')}</span>
    <p class="settings-hint">${t('revokeAll.hint')}</p>
   </div>
   <div class="settings-control settings-mobile-control">
    <ul class="mobile-devices" data-mobile-devices></ul>
    <button type="button" class="settings-button" data-mobile-revoke-all>${t('revokeAll')}</button>
   </div>
  </div>`;
}

function accountRow(provider) { return `  <div class="settings-row">
   <div class="settings-text">
    <span class="settings-label">${escapeHtml(I18n.t(`settings.${provider}.label`))}</span>
    <p class="settings-hint">${escapeHtml(I18n.t(`settings.${provider}.hint`))}</p>
   </div>
   <div class="settings-control settings-account" data-account="${provider}">
    <div class="settings-account-row">
     <span class="settings-account-who"></span>
     <button type="button" class="settings-button is-primary" data-action="login">${escapeHtml(I18n.t(`settings.${provider}.login`))}</button>
     <button type="button" class="settings-button" data-action="cancel">${escapeHtml(I18n.t(`settings.${provider}.cancel`))}</button>
     <button type="button" class="settings-button" data-action="logout">${escapeHtml(I18n.t(`settings.${provider}.logout`))}</button>
    </div>
    <p class="settings-status" data-provider="${provider}" role="status"></p>
   </div>
  </div>`;
}

function section(id, name, rows) {
 return `
  <section class="provider" data-provider="${id}" aria-labelledby="provider-${id}">
   <header class="provider-head">
    <h3 class="provider-name" id="provider-${id}">${escapeHtml(name)}</h3>
    <span class="provider-models"></span>
    <span class="provider-state"></span>
   </header>
   ${rows}
  </section>`;
}

class Settings {
 constructor(dialog) {
  this.dialog = dialog;
  this.list = dialog.querySelector('.settings-providers');
  this.unsaved = new Set();
  this.keys = this.readKeys();
  this.hand = this.readHand();
  this.accounts = Object.fromEntries(ACCOUNTS.map(provider => [provider, { connected: false }]));
  // The Telegram bot's settings, as the main process has them (desktop/telegram.js).
  this.telegramBridge = window.openghost?.telegram || null;
  this.telegram = { enabled: false, allowed: [], token: '', running: false, me: '', error: '', refused: '' };
  // The WhatsApp account's settings and connection (desktop/whatsapp.js).
  this.whatsappBridge = window.openghost?.whatsapp || null;
  this.whatsapp = { enabled: false, allowed: [], status: 'off', me: '', error: '', refused: '', qr: '' };
  // Phone access (desktop/mobile-companion.js): whether it listens, from where, and which phones it has let in.
  this.mobileBridge = window.openghost?.mobile || null;
  this.mobile = { enabled: false, lan: false, screens: false, port: 'auto', running: false, url: '', error: '', refused: '', devices: [] };
  // What a device-code sign-in asked to have shown while the browser waits: the code and the page that takes it.
  this.devices = {};
  this.catalog = this.readCatalog();
  this.models = [];
  this.efforts = EFFORTS.slice();
  localStorage.removeItem('deepseek.model');
  this.model = localStorage.getItem(STORAGE.model) || '';
  this.shown = this.model;
  this.read = 0;
  const effort = localStorage.getItem(STORAGE.effort);
  // Read the old application-wide value only to migrate existing chats. New chats use their model's default.
  this.legacyEffort = typeof effort === 'string' && effort ? effort : DEFAULT_EFFORT;
  this.effort = DEFAULT_EFFORT;
  const mode = localStorage.getItem(STORAGE.mode);
  this.mode = MODES.includes(mode) ? mode : DEFAULT_MODE;
  // Whether the picker shows only the models that cost nothing. A way of looking, kept between starts.
  this.freeOnly = localStorage.getItem(STORAGE.free) === 'on';
  // The model profiles: what this window is answered by, as a named preset rather than a single remembered model.
  // Read from the person's own folder, so it arrives a moment after the rest of the settings.
  this.profiles = new ModelProfiles();
  this.profile = 'default';
  this.profileEffort = '';
  // The active profile's fallbacks, in its order: the models that may answer when the chat's own cannot.
  this.fallbacks = [];
  // How the profile's model is asked: a temperature of its own (null means the model's), and a window of its own
  // (0 means the model's). Both belong to the profile's model, not to every chat that happens to be open.
  this.temperature = null;
  this.contextWindow = 0;
  this.checks = {};
  this.checked = new Set();
  // Keys saved in an earlier session count as working until a check says otherwise.
  this.accepted = new Set(Object.keys(KEYS).filter(provider => this.has(provider)));
  this.build();
  this.pager();
  this.collect();
  dialog.addEventListener('dismiss', () => dialog.close());
  dialog.addEventListener('close', () => { this.conceal(); this.grounded?.(); this.grounded = null; });
  // Mid-transition of the theme a click lands on <html>, outside the dialog, and must not close it.
  dialog.addEventListener('cancel', event => {
   if (window.Theme?.moving) event.preventDefault();
  });
  // A provider that found out something about one of its models asks for its list to be read again.
  window.addEventListener('models-stale', event => { if (this.connected(event.detail)) this.refresh(event.detail).catch(() => {}); });
  // A device-code sign-in tells the page which code to type while the browser has the sign-in open.
  window.openghost?.auth?.onDevice?.(info => {
   if (!info?.provider) return;
   this.devices[info.provider] = info;
   this.paint();
  });
  this.refreshAll();
  this.loadProfiles();
 }

 // The profiles are read after the settings are built, because the file lives where the chats do and is asked for over
 // the same bridge. Until it arrives the window keeps the model it had, which is what an install from before profiles
 // means anyway.
 loadProfiles() {
  // An install from before profiles may have named one fallback; it becomes the first entry of the default's list.
  const seed = { model: this.model, reasoning: this.legacyEffort, fallback: localStorage.getItem(STORAGE.fallback) || '' };
  return this.profiles.load(seed).then(() => this.applyProfile()).catch(() => {});
 }

 // What the active profile says this window is answered by and how. A profile with no model of its own leaves the
 // window's model alone — an empty preset is not a choice of "no model".
 applyProfile() {
  const profile = this.profiles.active();
  if (!profile) return;
  this.profile = profile.id;
  this.profileEffort = typeof profile.reasoning === 'string' ? profile.reasoning : '';
  this.fallbacks = Array.isArray(profile.fallbacks) ? profile.fallbacks.map(item => ({ ...item })) : [];
  this.temperature = typeof profile.temperature === 'number' ? profile.temperature : null;
  this.contextWindow = Number(profile.contextWindow) > 0 ? Math.round(Number(profile.contextWindow)) : 0;
  if (profile.model) this.model = profile.model;
  this.changed();
 }

 // Switching profiles carries the window's model with it; every chat already open keeps the one it was given.
 async setProfile(id) {
  if (id === this.profile) return false;
  if (!await this.profiles.activate(id)) return false;
  this.applyProfile();
  return true;
 }

 // What the Model page's Apply does: the profile in use takes the choices made on the page.
 async saveProfile(patch) {
  await this.profiles.update(this.profile, patch);
  this.applyProfile();
 }

 get profileName() {
  return this.profiles.name(this.profiles.active());
 }

 // The providers that can answer right now, in the order the settings and the picker show them.
 get connectedProviders() {
  return ORDER.filter(provider => this.connected(provider));
 }

 // The Model page's three changes to the list: one made from the one in use, one renamed, one removed. Removing or
 // making a profile changes what the window is answered by at once, so the page and the composer agree.
 async createProfile(name) {
  const made = await this.profiles.create(name, this.profiles.active());
  if (!made) return '';
  this.applyProfile();
  return made.id;
 }

 async renameProfile(name) {
  if (!await this.profiles.rename(this.profile, name)) return false;
  this.changed();
  return true;
 }

 async removeProfile() {
  if (!await this.profiles.remove(this.profile)) return false;
  this.applyProfile();
  return true;
 }

 // The sections on the left: one highlight glides to the chosen section, and its page rises into view.
 pager() {
  const dialog = this.dialog;
  this.tabs = [...dialog.querySelectorAll('.settings-tab')];
  this.panels = Object.fromEntries([...dialog.querySelectorAll('.settings-panel')].map(panel => [panel.dataset.page, panel]));
  this.glider = dialog.querySelector('.settings-glide');
  this.title = dialog.querySelector('.settings-page-title');
  this.scroller = dialog.querySelector('.settings-page');
  this.current = 'general';
  // As in the chat, the page fades into an edge while more of it lies scrolled out past that edge.
  const edges = () => {
   const page = this.scroller;
   dialog.classList.toggle('can-up', page.scrollTop > 1);
   dialog.classList.toggle('can-down', page.scrollTop + page.clientHeight < page.scrollHeight - 1);
  };
  this.scroller.addEventListener('scroll', edges, { passive: true });
  const sizes = new ResizeObserver(edges);
  sizes.observe(this.scroller);
  for (const panel of dialog.querySelectorAll('.settings-panel')) sizes.observe(panel);
  for (const tab of this.tabs) tab.addEventListener('click', () => this.page(tab.dataset.page));
  dialog.querySelector('.settings-tabs').addEventListener('keydown', event => {
   const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
   if (!step) return;
   event.preventDefault();
   const at = this.tabs.findIndex(tab => tab.dataset.page === this.current);
   const next = this.tabs[(at + step + this.tabs.length) % this.tabs.length];
   this.page(next.dataset.page);
   next.focus();
  });
 }

 page(name, instant = false) {
  const panel = this.panels[name];
  if (!panel) return;
  const moved = name !== this.current;
  this.current = name;
  for (const tab of this.tabs) {
   const on = tab.dataset.page === name;
   tab.setAttribute('aria-selected', String(on));
   tab.tabIndex = on ? 0 : -1;
  }
  this.glide(instant || !moved);
  if (!moved) return;
  for (const item of Object.values(this.panels)) item.hidden = item !== panel;
  this.title.textContent = I18n.t(`settings.${name}`);
  this.scroller.scrollTop = 0;
  if (instant || reducedMotion()) return;
  panel.animate([{ opacity: 0, transform: 'translateY(10px)', filter: 'blur(6px)' }, { opacity: 1, transform: 'none', filter: 'blur(0)' }], PAGE);
  this.title.animate([{ opacity: 0, transform: 'translateY(3px)', filter: 'blur(4px)' }, { opacity: 1, transform: 'none', filter: 'blur(0)' }], { ...PAGE, duration: 320 });
 }

 glide(instant) {
  const tab = this.tabs.find(item => item.dataset.page === this.current);
  if (!tab || !this.dialog.open) return;
  const style = this.glider.style;
  if (instant) style.transition = 'none';
  style.transform = `translateY(${tab.offsetTop}px)`;
  style.height = `${tab.offsetHeight}px`;
  style.opacity = '1';
  if (!instant) return;
  void this.glider.offsetHeight;
  style.transition = '';
 }

 readCatalog() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(STORAGE.catalog)) || {}; } catch {}
  return { ...Object.fromEntries(ORDER.map(provider => [provider, []])), ...saved };
 }

 // What the user wrote by hand for each provider that takes it.
 readHand() {
  const read = name => name ? String(localStorage.getItem(name) || '').trim() : '';
  return Object.fromEntries(Object.entries(HAND).map(([provider, at]) => {
   const context = Math.round(Number(read(at.context).replace(/[\s,._]/g, ''))) || 0;
   return [provider, { names: [...new Set(read(at.models).split(',').map(name => name.trim()).filter(Boolean))], context: context > 0 ? context : 0, address: read(at.address) }];
  }));
 }

 // The models of a server whose window is too small for the agent's own instructions, said under the address so the
 // user learns it in the settings and not from a chat that goes wrong.
 cramped(provider) {
  if (!SERVED.has(provider)) return '';
  const small = (this.catalog[provider] || []).filter(model => model.context < Providers.NEED);
  if (!small.length) return '';
  return I18n.t('settings.window.small', { models: small.slice(0, 3).map(model => `${model.name} (${model.context.toLocaleString('en-US')})`).join(', '), need: Providers.NEED.toLocaleString('en-US') });
 }

 // Whether a provider has been given what it is reached by: its key, or for a service at an address, the address.
 has(provider) {
  return provider === 'custom' ? !!this.hand.custom.address : !!this.keys[provider];
 }

 // What goes to a provider's list of models besides its key.
 extra(provider) {
  if (provider === 'custom') return { address: this.hand.custom.address };
  if (HAND[provider]) return { names: this.hand[provider].names };
  return undefined;
 }

 // A server's list with the user's own word laid over it: a name written by hand is a model even if the server did
 // not list it, and a window written by hand is the window of every model of that provider.
 byHand(provider, models) {
  const hand = this.hand[provider], listed = new Set(models.map(model => model.api));
  // A model named by hand is one nobody told anything about: a service's is offered the effort the OpenAI API takes,
  // "none" among it, as desktop/local.js offers it for a listed one; a local server's is left to think as it does.
  const think = provider === 'custom' ? { efforts: ['none', 'auto', 'low', 'medium', 'high'], defaultEffort: 'auto', thinking: 'levels' } : { efforts: ['auto'], defaultEffort: 'auto', thinking: 'none' };
  const own = hand.names.filter(name => !listed.has(name)).map(name => ({ id: `${provider}:${name}`, provider, api: name, name, context: 0, output: 0, vision: provider === 'custom', tools: true, ...think }));
  // A window written by hand is held to the largest the model can take, where the server tells that.
  const sized = model => hand.context ? (model.limit ? Math.min(hand.context, model.limit) : hand.context) : model.context || (model.limit ? Math.min(model.limit, LOCAL.window) : LOCAL.window);
  return [...models, ...own].map(model => ({ ...model, context: sized(model) }));
 }

 saveCatalog() {
  try { localStorage.setItem(STORAGE.catalog, JSON.stringify(this.catalog)); } catch {}
 }

 // The keys live in the OS keychain through the main process. Ones an earlier version kept in localStorage are the newest word,
 // so they move into the keychain once and leave localStorage only after it has them. Outside the desktop app they stay where they were.
 readKeys() {
  const vault = window.openghost?.keys, keys = { ...(vault?.read() || {}) };
  for (const [provider, name] of Object.entries(KEYS)) {
   const old = localStorage.getItem(name);
   if (!vault) { keys[provider] = old || ''; continue; }
   if (!old) continue;
   keys[provider] = old;
   vault.write(provider, old).then(saved => { if (saved) localStorage.removeItem(name); }).catch(() => {});
  }
  return Object.fromEntries(Object.keys(KEYS).map(provider => [provider, keys[provider] || '']));
 }

 // A key that could not be saved still works until the app closes; the line under its field says so rather than lose it quietly.
 saveKey(provider, key) {
  const vault = window.openghost?.keys;
  if (!vault) {
   if (key) localStorage.setItem(KEYS[provider], key);
   else localStorage.removeItem(KEYS[provider]);
   return;
  }
  vault.write(provider, key).then(saved => {
   if (key !== this.keys[provider]) return;
   if (saved) this.unsaved.delete(provider);
   else throw new Error('not saved');
  }).catch(() => {
   if (key !== this.keys[provider]) return;
   this.unsaved.add(provider);
   this.setStatus(provider, I18n.t('settings.key.unsaved'), 'error');
  });
 }

 // The eye beside a key shows it for a moment's check; closing the settings hides every key again.
 reveal(provider, shown) {
  const input = this.inputs[provider], eye = input.nextElementSibling;
  if (!eye) return;
  input.type = shown ? 'text' : 'password';
  input.parentElement.classList.toggle('is-revealed', shown);
  eye.setAttribute('aria-pressed', String(shown));
  eye.setAttribute('aria-label', I18n.t(shown ? 'settings.key.hide' : 'settings.key.show'));
 }

 conceal() {
  for (const provider of Object.keys(this.inputs || {})) this.reveal(provider, false);
 }

 connected(provider) {
  return ACCOUNTS.includes(provider) ? !!this.accounts[provider]?.connected : this.has(provider);
 }

 // The badge turns green only once the provider has taken the key, so a mistyped key never looks connected.
 working(provider) {
  return this.connected(provider) && (ACCOUNTS.includes(provider) || this.accepted.has(provider));
 }

 // The picker offers the models of every connected provider, as each provider lists them. No model is known to the app
 // by itself: with nothing connected there is none, and the picker leads to the settings instead.
 collect() {
  this.models = ORDER.filter(provider => this.connected(provider)).flatMap(provider => this.catalog[provider] || []);
  this.paint();
 }

 find(id) {
  return this.models.find(item => item.id === id) || null;
 }

 // A chat keeps its own model; one that is no longer offered falls back to the model new chats get.
 // Chats started before this was fixed kept the provider's model name rather than the picker's id, so that name is looked up too.
 resolve(id) {
  if (id && this.find(id)) return id;
  const named = id && this.models.find(item => item.api === id);
  if (named) return named.id;
  if (this.find(this.model)) return this.model;
  // Before the user has picked one, new chats get the first model the app's first provider lists, or the first there is.
  return (this.models.find(item => item.provider === FIRST_PROVIDER) || this.models[0])?.id || '';
 }

 configFor(id, preferred = '') {
  const model = this.find(id);
  const provider = model?.provider || FIRST_PROVIDER;
  const efforts = model?.efforts?.length ? model.efforts : EFFORTS;
  const effort = efforts.includes(preferred) ? preferred : [model?.defaultEffort, DEFAULT_EFFORT].find(level => efforts.includes(level)) || efforts[efforts.length - 1];
  // A window written on a profile belongs to that profile's model: a chat that was given another model keeps that
  // model's own window, which is the one the chat actually fits.
  const mine = !!model && id === this.profiles.active()?.model;
  const window = mine && this.contextWindow > 0 ? this.contextWindow
   : SERVED.has(provider) ? model?.context || LOCAL.window : undefined;
  return {
   id: model?.id || id,
   provider,
   model: model?.api || id,
   name: model?.name || id,
   key: this.keys[provider] || '',
   address: provider === 'custom' ? this.hand.custom.address : undefined,
   // The window a model on a server of the user's works in: Ollama is asked for it with every request.
   window,
   // An engine that can carry a temperature reads this; one that cannot leaves it alone, and a reasoning model is never
   // sent one (see the engines' own rule).
   temperature: mine && typeof this.temperature === 'number' ? this.temperature : null,
   ready: !!model && this.connected(provider),
   effort,
   efforts,
   fast: model?.fast === true,
   fastBeta: model?.fastBeta || '',
   fastLookup: model?.fastLookup === true && typeof model.fast !== 'boolean',
   speed: 'standard',
   vision: model?.vision !== false,
   // A model that calls no tools is talked to as a plain chat.
   tools: model?.tools !== false,
   thinking: model?.thinking,
   output: model?.output,
  };
 }

 get config() {
  return this.configFor(this.resolve(this.model));
 }

 windowOf(id) {
  // The same rule configFor uses: a profile's own window stands for the model it names, and nowhere else.
  if (id === this.profiles.active()?.model && this.contextWindow > 0) return this.contextWindow;
  return this.find(id)?.context || DEFAULT_CONTEXT;
 }

 // The effort steps follow the model of the chat on screen.
 show(id) {
  if (id === this.shown) return;
  this.shown = id;
  this.applyEfforts();
 }

 applyEfforts() {
  const model = this.find(this.shown);
  const efforts = model?.efforts?.length ? model.efforts : EFFORTS;
  const same = efforts.length === this.efforts.length && efforts.every((level, i) => level === this.efforts[i]);
  this.efforts = efforts.slice();
  if (!efforts.includes(this.effort)) {
   const fallback = [model?.defaultEffort, DEFAULT_EFFORT].find(level => efforts.includes(level));
   this.effort = fallback || efforts[Math.min(efforts.length - 1, 2)];
  }
  if (!same) this.onEfforts?.(this.efforts);
 }

 setModel(id) {
  if (id === this.model || !this.find(id)) return;
  this.model = id;
  localStorage.setItem(STORAGE.model, id);
 }

 // View-only compatibility for controls without a chat. A chat's slider writes through Chat.setEffort.
 setEffort(value) {
  this.effort = value;
 }

 setMode(value) {
  if (!MODES.includes(value)) return;
  this.mode = value;
  localStorage.setItem(STORAGE.mode, value);
 }

 // The picker's way of looking: only the models that cost nothing, or all of them. It changes nothing about the chat,
 // which keeps its model whichever of the two the list is showing.
 setFreeOnly(on) {
  this.freeOnly = !!on;
  try { localStorage.setItem(STORAGE.free, this.freeOnly ? 'on' : 'off'); } catch {}
 }

 changed() {
  this.collect();
  this.applyEfforts();
  this.onModels?.();
 }

 // What another window of the app has changed since this one read it: the keys, the sign-in, the providers' lists of
 // models, and the model and mode last chosen. Chat effort is kept in the library, not in these shared preferences.
 async reread() {
  this.keys = this.readKeys();
  this.hand = this.readHand();
  for (const provider of Object.keys(KEYS)) {
   if (this.has(provider)) this.accepted.add(provider);
   else this.accepted.delete(provider);
  }
  this.catalog = this.readCatalog();
  this.model = localStorage.getItem(STORAGE.model) || '';
  const mode = localStorage.getItem(STORAGE.mode);
  if (MODES.includes(mode)) this.mode = mode;
  this.freeOnly = localStorage.getItem(STORAGE.free) === 'on';
  // The profiles are read again too: another window may have switched or edited one, and a profile carries the
  // fallbacks in its order. Only a file that was read before is asked for again — a first read is the migration's.
  if (this.profiles.data) await this.profiles.load({}).then(() => this.applyProfile()).catch(() => {});
  this.changed();
  await this.syncAccounts();
 }

 async refreshAll() {
  this.read = Date.now();
  await this.syncAccounts();
  await Promise.all([
   ...Object.keys(KEYS).filter(provider => this.has(provider)).map(provider => this.checkKey(provider)),
   ...ACCOUNTS.filter(provider => this.accounts[provider].connected).map(provider => this.refresh(provider).catch(() => {})),
  ]);
 }

 // Reads the providers' lists again once they are no longer fresh, quietly: a model a provider has added since shows up
 // the next time the picker opens, with no restart. A list that can't be read now leaves the last one in place.
 freshen() {
  if (Date.now() - this.read < FRESH) return;
  this.read = Date.now();
  for (const provider of ORDER) if (this.connected(provider)) this.refresh(provider).catch(() => {});
 }

 // A sign-in can lapse while the app runs, so the settings ask how it stands each time they open.
 async syncAccounts() {
  await Promise.all(ACCOUNTS.map(provider => this.syncAccount(provider)));
 }

 async syncAccount(provider) {
  const auth = window.openghost?.auth;
  if (!auth || this.accounts[provider].waiting) return;
  const account = await auth.status(provider).catch(() => null);
  if (account && !this.accounts[provider].waiting) this.setAccount(provider, account);
 }

 // Loads a provider's models into the catalog; the last request for a provider wins.
 async refresh(provider) {
  const token = (this.checks[provider] = (this.checks[provider] || 0) + 1);
  let models;
  try {
   models = await Providers.models(provider, this.keys[provider], this.extra(provider));
  } catch (error) {
   // A server that gives no list still serves the models the user named by hand. A key it does not take is another
   // matter: nothing would answer.
   if (!SERVED.has(provider) || !this.hand[provider].names.length || error.status === 401 || error.status === 403) throw error;
   models = [];
  }
  if (token !== this.checks[provider]) return false;
  this.catalog[provider] = SERVED.has(provider) ? this.byHand(provider, models) : models;
  this.saveCatalog();
  this.changed();
  return true;
 }

 build() {
  this.list.innerHTML = [
   section('openai', 'OpenAI', accountRow('chatgpt') + keyRow('openai') + handRow('openai', 'models', 'gpt-…')),
   section('grok', 'Grok', accountRow('grok')),
   section('iteracompute', 'IteraCompute', keyRow('iteracompute') + handRow('iteracompute', 'models', 'qwen/qwen3.8-27b')),
   section('zro', 'Zro', keyRow('zro') + handRow('zro', 'models', 'deepseek-v4.1-flash')),
   section('infron', 'Infron', keyRow('infron') + handRow('infron', 'models', 'qwen/qwen3.8-27b:free')),
   section('tokenharbor', 'Token Harbor', keyRow('tokenharbor') + handRow('tokenharbor', 'models', 'openai/deepseek-v4.1-flash:free')),
   section('yeta', 'Yeta', keyRow('yeta') + handRow('yeta', 'models', 'deepseek-v4.1-flash')),
   section('wusrouter', 'WusRouter', keyRow('wusrouter') + handRow('wusrouter', 'models', 'uc/deepseek-v4-flash:free')),
   section('coarena', 'Coarena', keyRow('coarena') + handRow('coarena', 'models', 'claude-sonnet-5-5')),
   section('nararouter', 'NaraRouter', keyRow('nararouter') + handRow('nararouter', 'models', 'agnes-3-flash')),
   section('crowllm', 'CrowLLM', keyRow('crowllm') + handRow('crowllm', 'models', 'gpt-4o:free')),
   section('anthropic', 'Anthropic', keyRow('anthropic') + handRow('anthropic', 'models', 'claude-…')),
   section('deepseek', 'DeepSeek', keyRow('deepseek')),
   section('openrouter', 'OpenRouter', keyRow('openrouter')),
   section('nvidia', 'NVIDIA', keyRow('nvidia') + handRow('nvidia', 'models', 'meta/llama3-70b-instruct')),
   section('gemini', 'Gemini', keyRow('gemini') + handRow('gemini', 'models', 'gemini-2.5-flash')),
   section('venice', 'Venice', keyRow('venice') + handRow('venice', 'models', 'venice-uncensored-1-2')),
   section('telegram', 'Telegram', telegramRows()),
   section('whatsapp', 'WhatsApp', whatsappRows()),
   section('mobile', I18n.t('settings.mobile'), mobileRows()),
   section('local', I18n.t('settings.local.name'), localRows()),
   section('custom', I18n.t('settings.custom.name'), customRows()),
  ].join('');
  this.inputs = {};
  for (const input of this.list.querySelectorAll('.settings-key[data-provider]')) {
   const provider = input.dataset.provider;
   this.inputs[provider] = input;
   input.value = this.keys[provider];
   input.addEventListener('input', () => this.onKeyInput(provider));
   input.nextElementSibling?.addEventListener('click', () => this.reveal(provider, input.type === 'password'));
  }
  for (const button of this.list.querySelectorAll('.settings-preset')) {
   button.addEventListener('click', () => { this.inputs.local.value = button.dataset.address; this.onKeyInput('local'); });
  }
  // What is written by hand is kept as it is typed, and the provider's list is read again with it.
  for (const input of this.list.querySelectorAll('[data-hand]')) {
   const [provider, name] = input.dataset.hand.split('.'), at = HAND[provider][name];
   input.value = localStorage.getItem(at) || '';
   input.addEventListener('input', () => {
    const value = input.value.trim();
    if (value) localStorage.setItem(at, value);
    else localStorage.removeItem(at);
    this.hand = this.readHand();
    if (this.has(provider) || name === 'address') this.onKeyInput(provider);
   });
  }
  this.statuses = Object.fromEntries([...this.list.querySelectorAll('.settings-status')].map(node => [node.dataset.provider, node]));
  this.accountBoxes = {};
  for (const box of this.list.querySelectorAll('.settings-account')) {
   const provider = box.dataset.account;
   this.accountBoxes[provider] = box;
   box.addEventListener('click', event => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'login') this.login(provider);
    else if (action === 'cancel') window.openghost?.auth?.cancel(provider);
    else if (action === 'logout') this.logout(provider);
   });
   if (!window.openghost?.auth) box.closest('.settings-row').hidden = true;
  }
  this.wireTelegram();
  this.wireWhatsApp();
  this.wireMobile();
 }

 // The Telegram section: the token and the user ids are kept as they are typed, a moment after the last key; the switch
 // at once. The main process starts or stops the bot and says how it stands, which the line under the switch shows.
 wireTelegram() {
  const box = this.telegramBox = this.list.querySelector('.provider[data-provider="telegram"]');
  if (!box) return;
  const bridge = this.telegramBridge;
  if (!bridge) { box.hidden = true; return; }
  this.telegramToken = box.querySelector('[data-telegram="token"]');
  this.telegramAllowed = box.querySelector('[data-telegram="allowed"]');
  this.telegramSwitch = box.querySelector('.telegram-switch');
  this.telegramStatus = box.querySelector('[data-telegram-status]');
  const eye = this.telegramToken.nextElementSibling;
  eye?.addEventListener('click', () => {
   const shown = this.telegramToken.type === 'password';
   this.telegramToken.type = shown ? 'text' : 'password';
   eye.setAttribute('aria-pressed', String(shown));
   eye.setAttribute('aria-label', I18n.t(shown ? 'settings.key.hide' : 'settings.key.show'));
  });
  const timers = {};
  const save = (name, changes, after) => {
   clearTimeout(timers[name]);
   timers[name] = setTimeout(async () => {
    const state = await bridge.set(changes).catch(() => null);
    if (state) this.takeTelegram(state);
    else if (name === 'enabled') {
     // The main process did not answer: the switch goes back to where the backend last said it stood, and the
     // failure is said out loud.
     this.telegramSwitch?.setAttribute('aria-checked', String(!!this.telegram?.enabled));
     if (this.telegramStatus) {
      this.telegramStatus.textContent = I18n.t('settings.telegram.unreachable');
      this.telegramStatus.dataset.tone = 'error';
     }
    }
   }, after);
  };
  this.telegramToken.addEventListener('input', () => save('token', { token: this.telegramToken.value }, CHECK_DELAY));
  this.telegramAllowed.addEventListener('input', () => save('allowed', { allowed: this.telegramAllowed.value }, CHECK_DELAY));
  this.telegramSwitch.addEventListener('click', () => {
   const on = this.telegramSwitch.getAttribute('aria-checked') !== 'true';
   // The switch answers at once; the main process's word, when it comes, is the last word.
   this.telegramSwitch.setAttribute('aria-checked', String(on));
   save('enabled', { enabled: on }, 0);
  });
  bridge.onChange?.(state => this.takeTelegram(state));
  this.refreshTelegram();
 }

 async refreshTelegram() {
  if (!this.telegramBridge) return;
  const state = await this.telegramBridge.get().catch(() => null);
  if (state) this.takeTelegram(state);
 }

 // What the main process says of the bot: its fields, the switch, and a line telling whether it is on the air, waiting
 // for a token, or refusing one. Fields being typed into are left as they are.
 takeTelegram(state) {
  if (!state) return;
  this.telegram = { ...this.telegram, ...state, refused: state.refused || '' };
  if (!this.telegramBox) return;
  if (this.telegramToken && document.activeElement !== this.telegramToken) this.telegramToken.value = state.token || '';
  if (this.telegramAllowed && document.activeElement !== this.telegramAllowed) this.telegramAllowed.value = (state.allowed || []).join(', ');
  this.telegramSwitch?.setAttribute('aria-checked', String(!!state.enabled));
  const error = state.refused ? I18n.t(state.refused === 'token' ? 'settings.telegram.badToken' : 'settings.telegram.badAllowed') : state.error || '';
  let status = error;
  if (!status && !state.enabled) status = I18n.t('settings.telegram.off');
  if (!status && !state.token) status = I18n.t('settings.telegram.needToken');
  if (!status && !state.running) status = I18n.t('settings.telegram.starting');
  if (!status && !state.allowed?.length) status = I18n.t('settings.telegram.needAllowed');
  if (!status) status = I18n.t('settings.telegram.running', { who: state.me || 'Telegram' });
  if (this.telegramStatus) {
   this.telegramStatus.textContent = status;
   this.telegramStatus.dataset.tone = error ? 'error' : '';
  }
  this.paintTelegram();
 }

 paintTelegram() {
  const box = this.telegramBox;
  if (!box) return;
  const state = this.telegram;
  const badge = box.querySelector('.provider-state');
  if (badge) {
   // An enabled bot that refused its token or could not reach Telegram is not starting: it is down.
   const bad = !!state.enabled && !state.running && !!(state.error || state.refused);
   badge.textContent = I18n.t(state.running ? 'settings.telegram.badgeRunning' : bad ? 'settings.telegram.badgeError' : 'settings.telegram.badgeStopped');
   badge.classList.toggle('is-on', !!state.running);
   badge.classList.toggle('is-bad', bad);
  }
  const models = box.querySelector('.provider-models');
  if (models) models.textContent = '';
 }

 // The WhatsApp section: the numbers are kept as they are typed, a moment after the last key; the switch at once. The
 // main process opens or closes the session and says how it stands; the QR code appears while linking.
 wireWhatsApp() {
  const box = this.whatsappBox = this.list.querySelector('.provider[data-provider="whatsapp"]');
  if (!box) return;
  const bridge = this.whatsappBridge;
  if (!bridge) { box.hidden = true; return; }
  this.whatsappAllowed = box.querySelector('[data-whatsapp="allowed"]');
  this.whatsappSwitch = box.querySelector('.whatsapp-switch');
  this.whatsappStatus = box.querySelector('[data-whatsapp-status]');
  this.whatsappQr = box.querySelector('[data-whatsapp-qr]');
  this.whatsappQrStatus = box.querySelector('[data-whatsapp-qr-status]');
  let typing = null;
  this.whatsappAllowed.addEventListener('input', () => {
   clearTimeout(typing);
   typing = setTimeout(async () => {
    const state = await bridge.set({ allowed: this.whatsappAllowed.value }).catch(() => null);
    if (state) this.takeWhatsApp(state);
   }, CHECK_DELAY);
  });
  this.whatsappSwitch.addEventListener('click', async () => {
   const next = this.whatsappSwitch.getAttribute('aria-checked') !== 'true';
   const state = await bridge.set({ enabled: next }).catch(() => null);
   if (state) this.takeWhatsApp(state);
  });
  bridge.onChange?.(state => this.takeWhatsApp(state));
  this.refreshWhatsApp();
 }

 async refreshWhatsApp() {
  if (!this.whatsappBridge) return;
  const state = await this.whatsappBridge.get().catch(() => null);
  if (!state) return;
  this.takeWhatsApp(state);
  if (state.status === 'qr' && !state.qr) {
   const code = await this.whatsappBridge.getQrCode().catch(() => null);
   if (code?.qr) this.takeWhatsApp({ ...state, qr: code.qr });
  }
 }

 // What the main process says of WhatsApp: the numbers, the switch, the QR code while linking, and a line telling
 // whether it is connected, waiting for a scan, or reconnecting. The field being typed into is left as it is.
 takeWhatsApp(state) {
  if (!state) return;
  this.whatsapp = { ...this.whatsapp, ...state, refused: state.refused || '' };
  if (!this.whatsappBox) return;
  if (this.whatsappAllowed && document.activeElement !== this.whatsappAllowed) this.whatsappAllowed.value = (state.allowed || []).join(', ');
  this.whatsappSwitch?.setAttribute('aria-checked', String(!!state.enabled));
  const refused = state.refused ? I18n.t('settings.whatsapp.badAllowed') : '';
  const status = state.status || 'off';
  const words = status === 'connected' ? I18n.t('settings.whatsapp.connected', { who: state.me || 'WhatsApp' })
   : status === 'qr' ? I18n.t('settings.whatsapp.scan')
   : status === 'starting' ? I18n.t('settings.whatsapp.starting')
   : status === 'reconnecting' ? state.error || I18n.t('settings.whatsapp.reconnecting')
   : status === 'loggedOut' ? I18n.t('settings.whatsapp.loggedOut')
   : status === 'error' ? state.error || I18n.t('settings.whatsapp.error')
   : I18n.t('settings.whatsapp.off');
  if (this.whatsappStatus) {
   this.whatsappStatus.textContent = refused || words;
   this.whatsappStatus.dataset.tone = refused || status === 'error' || status === 'loggedOut' ? 'error' : '';
  }
  const qr = status === 'qr' ? state.qr || '' : '';
  if (this.whatsappQr) {
   if (qr) {
    this.whatsappQr.src = qr;
    this.whatsappQr.hidden = false;
   } else {
    this.whatsappQr.removeAttribute('src');
    this.whatsappQr.hidden = true;
   }
  }
  if (this.whatsappQrStatus) {
   this.whatsappQrStatus.textContent = qr ? I18n.t('settings.whatsapp.scan')
    : status === 'connected' ? I18n.t('settings.whatsapp.qr.linked')
    : !state.enabled ? I18n.t('settings.whatsapp.qr.waiting')
    : I18n.t('settings.whatsapp.starting');
  }
  this.paintWhatsApp();
 }

 paintWhatsApp() {
  const box = this.whatsappBox;
  if (!box) return;
  const state = this.whatsapp, status = state.status || 'off';
  const badge = box.querySelector('.provider-state');
  if (!badge) return;
  const bad = status === 'error' || status === 'loggedOut' || status === 'reconnecting';
  badge.textContent = I18n.t(
   status === 'connected' ? 'settings.whatsapp.badgeConnected'
   : status === 'qr' ? 'settings.whatsapp.badgeScan'
   : bad ? 'settings.whatsapp.badgeError'
   : 'settings.whatsapp.badgeStopped');
  badge.classList.toggle('is-on', status === 'connected');
  badge.classList.toggle('is-bad', bad);
 }

 // The Phone access section: the switches take the server up or down at once, the port a moment after the last key is
 // typed. The code a phone reads is not drawn here — the button opens the same window the sidebar's icon does, so the
 // pairing is answered in one place.
 wireMobile() {
  const box = this.mobileBox = this.list.querySelector('.provider[data-provider="mobile"]');
  if (!box) return;
  const bridge = this.mobileBridge;
  if (!bridge) { box.hidden = true; return; }
  this.mobileUrl = box.querySelector('[data-mobile-url]');
  this.mobileStatus = box.querySelector('[data-mobile-status]');
  this.mobilePort = box.querySelector('[data-mobile="port"]');
  this.mobileDevices = box.querySelector('[data-mobile-devices]');
  for (const node of box.querySelectorAll('.mobile-switch')) {
   node.addEventListener('click', async () => {
    const next = node.getAttribute('aria-checked') !== 'true';
    node.setAttribute('aria-checked', String(next));
    const state = await bridge.set({ [node.dataset.mobile]: next }).catch(() => null);
    if (state) this.takeMobile(state);
   });
  }
  let typing = null;
  this.mobilePort.addEventListener('input', () => {
   clearTimeout(typing);
   typing = setTimeout(async () => {
    const state = await bridge.set({ port: this.mobilePort.value.trim() || 'auto' }).catch(() => null);
    if (state) this.takeMobile(state);
   }, 500);
  });
  box.querySelector('[data-mobile-pair]').addEventListener('click', () => {
   document.querySelector('.sidebar-mobile')?.dispatchEvent(new CustomEvent('mobile-open'));
  });
  box.querySelector('[data-mobile-revoke-all]').addEventListener('click', async () => {
   for (const device of this.mobile.devices || []) await bridge.revoke(device.id).catch(() => null);
   this.takeMobile(await bridge.get().catch(() => null));
  });
  this.mobileDevices.addEventListener('click', event => {
   const row = event.target.closest('[data-device]');
   if (!row) return;
   const id = row.dataset.device;
   const asked = event.target.closest('[data-revoke]') ? bridge.revoke(id) : event.target.closest('[data-disconnect]') ? bridge.disconnect(id) : null;
   if (asked) asked.then(state => state && this.takeMobile(state));
  });
  bridge.onChange?.(state => state && this.takeMobile(state));
  this.refreshMobile();
 }

 async refreshMobile() {
  if (!this.mobileBridge) return;
  const state = await this.mobileBridge.get().catch(() => null);
  if (state) this.takeMobile(state);
 }

 // What the main process says of it: the switches, the address a phone opens, whether it listens, and which phones the
 // app has let in. The field being typed into is left as it is.
 takeMobile(state) {
  if (!state) return;
  this.mobile = { ...this.mobile, ...state, refused: state.refused || '' };
  if (!this.mobileBox) return;
  for (const node of this.mobileBox.querySelectorAll('.mobile-switch')) {
   node.setAttribute('aria-checked', String(!!state[node.dataset.mobile]));
  }
  if (this.mobilePort && document.activeElement !== this.mobilePort) this.mobilePort.value = state.port === 'auto' ? '' : String(state.port);
  this.mobileUrl.textContent = state.running ? state.url : '';
  const bad = state.refused || state.error;
  this.mobileStatus.textContent = state.error
   || (state.refused ? I18n.t('settings.mobile.port.bad') : state.running
    ? I18n.t('settings.mobile.running', { where: state.url })
    : I18n.t('settings.mobile.stopped'));
  this.mobileStatus.dataset.tone = bad ? 'error' : '';
  this.drawMobileDevices(state);
  this.paintMobile();
 }

 // One line per phone: what it is, when it was last here, and whether it is here now. A phone that is here is let go;
 // one that is not loses its way back.
 drawMobileDevices(state) {
  const devices = state.devices || [];
  this.mobileDevices.innerHTML = devices.length
   ? devices.map(device => `
    <li class="mobile-device${device.online ? ' is-online' : ''}" data-device="${escapeHtml(device.id)}">
     <span class="mobile-device-mark" aria-hidden="true"></span>
     <span class="mobile-device-name">${escapeHtml(device.name || device.id)}</span>
     <span class="mobile-device-when">${escapeHtml(device.online
      ? I18n.t('mobile.here')
      : [device.lastSeen ? I18n.t('settings.mobile.lastseen', { when: new Intl.DateTimeFormat(I18n.lang, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(device.lastSeen) }) : I18n.t('mobile.never'), device.lastAddress].filter(Boolean).join(' · '))}</span>
     ${device.online
      ? `<button type="button" class="mobile-quiet" data-disconnect>${escapeHtml(I18n.t('mobile.disconnect'))}</button>`
      : `<button type="button" class="mobile-quiet" data-revoke>${escapeHtml(I18n.t('mobile.revoke'))}</button>`}
    </li>`).join('')
   : `<li class="mobile-device is-none">${escapeHtml(I18n.t('settings.mobile.devices.none'))}</li>`;
 }

 paintMobile() {
  const box = this.mobileBox, badge = box?.querySelector('.provider-state');
  if (!badge) return;
  const running = !!this.mobile.running, online = (this.mobile.devices || []).some(device => device.online);
  badge.textContent = I18n.t(online ? 'settings.mobile.badgeLive' : running ? 'settings.mobile.badgeOn' : 'settings.mobile.badgeOff');
  badge.classList.toggle('is-on', running);
  badge.classList.toggle('is-bad', !!this.mobile.error);
 }

 paint() {
  if (!this.list) return;
  for (const node of this.list.querySelectorAll('.provider')) {
   const id = node.dataset.provider;
   // Telegram and WhatsApp are not model providers: their badges say whether the bot or the session runs (paintTelegram,
   // paintWhatsApp). Nor is phone access: its badge says whether a server is listening.
   if (id === 'telegram' || id === 'whatsapp' || id === 'mobile') continue;
   // OpenAI is connected through either the ChatGPT sign-in or a key; a model both offer counts once.
   const live = (id === 'openai' ? ['chatgpt', 'openai'] : [id]).filter(source => this.working(source));
   const on = live.length > 0, count = new Set(live.flatMap(source => this.catalog[source] || []).map(model => model.api)).size;
   const state = node.querySelector('.provider-state');
   state.textContent = I18n.t(on ? 'settings.connected' : 'settings.off');
   state.classList.toggle('is-on', on);
   node.querySelector('.provider-models').textContent = on && count ? I18n.t('settings.models', { count }) : '';
  }
  for (const provider of ACCOUNTS) {
   const box = this.accountBoxes?.[provider];
   if (!box) continue;
   const account = this.accounts[provider], device = this.devices[provider];
   box.dataset.state = account.waiting ? 'waiting' : account.connected ? 'connected' : 'idle';
   const who = [account.email, this.planOf(provider, account)].filter(Boolean).join(' · ');
   box.querySelector('.settings-account-who').textContent = account.waiting
    ? (device?.code ? I18n.t('settings.grok.code', { code: device.code }) : I18n.t(`settings.${provider}.waiting`))
    : who;
  }
  this.paintTelegram();
 }

 // The plan a signed-in provider speaks for: ChatGPT by its own word, Grok by the tier its tokens carry.
 planOf(provider, account) {
  if (provider === 'grok') return account.subscription || '';
  return account.plan ? I18n.t('settings.chatgpt.plan', { plan: account.plan.charAt(0).toUpperCase() + account.plan.slice(1) }) : '';
 }

 setAccount(provider, account) {
  const was = this.accounts[provider].connected;
  this.accounts[provider] = {
   connected: !!account?.connected,
   email: account?.email || '',
   plan: account?.plan || '',
   subscription: account?.subscription || '',
  };
  if (account?.error) this.setStatus(provider, account.error, 'error');
  if (!account?.connected) this.devices[provider] = null;
  if (this.accounts[provider].connected && !this.catalog[provider]?.length) this.refresh(provider).catch(() => {});
  if (was !== this.accounts[provider].connected) this.changed();
  else this.paint();
 }

 async login(provider) {
  const auth = window.openghost?.auth;
  if (!auth || this.accounts[provider].waiting) return;
  this.setStatus(provider, '');
  this.devices[provider] = null;
  this.accounts[provider] = { ...this.accounts[provider], waiting: true };
  this.paint();
  const account = await auth.login(provider);
  this.setAccount(provider, account);
  // The badge turning green and the account line say it all; a "signed in" line under them would only repeat it.
  if (account?.connected) await this.refresh(provider).catch(() => {});
 }

 async logout(provider) {
  const auth = window.openghost?.auth;
  if (!auth) return;
  this.devices[provider] = null;
  this.setAccount(provider, await auth.logout(provider));
  this.setStatus(provider, '');
 }

 open(reason = '', provider = '') {
  const opening = !this.dialog.open;
  if (opening) {
   this.dialog.showModal();
   // Over the sidebar of a window of glass it needs a ground under it to be frosted there too (glass-ground.js).
   this.grounded = window.GlassGround?.hold(this.dialog);
   this.dialog.focus();
   this.syncAccounts();
   this.refreshTelegram();
  }
  // A missing key opens straight on Providers; otherwise the settings always open on General.
  if (reason) this.page('providers', opening);
  else if (opening) this.page('general', true);
  if (reason) {
   const target = provider || FIRST_PROVIDER;
   this.setStatus(target, reason, 'error');
   const field = ACCOUNTS.includes(target) ? this.accountBoxes[target]?.querySelector('[data-action="login"]') : this.inputs[target];
   field?.scrollIntoView({ block: 'center' });
   field?.focus();
   return;
  }
  for (const provider of Object.keys(KEYS)) {
   if (this.has(provider) && !this.checked.has(provider)) this.checkKey(provider);
  }
 }

 onKeyInput(provider) {
  const key = this.inputs[provider].value.trim();
  this.keys[provider] = key;
  this.saveKey(provider, key);
  clearTimeout(this.timer?.[provider]);
  this.timer = { ...this.timer };
  this.checked.delete(provider);
  this.accepted.delete(provider);
  if (!this.has(provider)) {
   this.setStatus(provider, '');
   this.changed();
   return;
  }
  this.paint();
  this.setStatus(provider, checking(provider));
  this.timer[provider] = setTimeout(() => this.checkKey(provider), CHECK_DELAY);
 }

 // A working key shows only in the badge; the line under the field is for the check in progress and for what went wrong.
 async checkKey(provider) {
  const key = this.keys[provider];
  this.setStatus(provider, checking(provider));
  try {
   const current = await this.refresh(provider);
   if (!current || key !== this.keys[provider]) return;
   this.accepted.add(provider);
   this.checked.add(provider);
   if (this.unsaved.has(provider)) this.setStatus(provider, I18n.t('settings.key.unsaved'), 'error');
   else {
    const small = this.cramped(provider);
    this.setStatus(provider, small, small ? 'error' : '');
   }
  } catch (error) {
   if (key !== this.keys[provider]) return;
   this.accepted.delete(provider);
   // A service that wants a key and was given none is not one that turned a key down.
   const keyless = provider === 'custom' && !key && error.status === 401;
   this.setStatus(provider, keyless ? I18n.t('settings.custom.needsKey') : error.message, 'error');
  }
  this.paint();
 }

 setStatus(provider, text, tone = '') {
  const node = this.statuses?.[provider];
  if (!node) return;
  node.textContent = text;
  node.dataset.tone = tone;
 }
}

window.Settings = Settings;
})();
