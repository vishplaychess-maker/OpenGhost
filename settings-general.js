(() => {
'use strict';

// Settings → General: the user's standing instructions and the files OpenGhost keeps at hand in every chat.
// Everything saves as it changes; UserContext passes it to the model.
const ROW = { duration: 420, easing: 'cubic-bezier(0.32, 0.72, 0, 1)' };
// A row folded shut: its padding goes too, or the height could not reach zero.
const FOLDED = { height: '0px', paddingTop: '0px', paddingBottom: '0px' };
const STATUS_TIME = 6000;
const CHARS_PER_TOKEN = 3.2;
const PLUS = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M8 3.2v9.6M3.2 8h9.6"/></svg>';
const CROSS = '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6"/></svg>';

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const escapeHtml = text => String(text).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const hasFiles = event => [...(event.dataTransfer?.types || [])].includes('Files');
const tokens = chars => {
 const count = Math.max(1, Math.round(chars / CHARS_PER_TOKEN));
 return count < 1000 ? String(count) : `${(count / 1000).toFixed(count < 10000 ? 1 : 0).replace(/\.0$/, '')}k`;
};

// The quick chat's settings: whether it is on, the keys that call it, and whether the app starts with the computer.
// The keys are set by pressing them: the field listens until a combination comes, and Escape leaves it as it was.
const QUICK_KEYS = { Space: 'Space', Tab: 'Tab', Enter: 'Enter', Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/' };
const QUICK_NAMES = { Control: 'Ctrl', Command: '⌘', Super: 'Win', Up: '↑', Down: '↓', Left: '←', Right: '→' };

class QuickSettings {
 constructor(root) {
  this.root = root;
  this.bridge = window.openghost?.quickChat;
  if (!this.bridge) return;
  this.mac = window.openghost.platform === 'darwin';
  this.toggle = root.querySelector('.quick-switch');
  this.keys = root.querySelector('.quick-keys');
  this.startup = root.querySelector('.quick-startup');
  this.startupToggle = root.querySelector('.quick-startup-switch');
  this.status = root.querySelector('.quick-status');
  this.state = null;
  this.recording = false;
  this.toggle.addEventListener('click', () => this.set({ on: !this.state.on }));
  this.startupToggle.addEventListener('click', () => this.set({ startup: !this.state.startup }));
  this.keys.addEventListener('click', () => this.record(!this.recording));
  this.keys.addEventListener('blur', () => this.record(false));
  this.keys.addEventListener('keydown', event => this.onKey(event));
  // Where the quick chat is not to be had, the block stays out of sight.
  this.bridge.get().then(state => {
   if (!state) return;
   root.hidden = false;
   this.paint(state);
  }).catch(() => {});
 }

 async set(changes) {
  const state = await this.bridge.set({ ...this.state, ...changes });
  if (state) this.paint(state);
 }

 record(on) {
  if (this.recording === on || !this.state?.on) return;
  this.recording = on;
  this.paint(this.state);
 }

 onKey(event) {
  if (!this.recording) return;
  event.preventDefault();
  event.stopPropagation();
  if (event.key === 'Escape') { this.record(false); return; }
  const code = event.code;
  const key = /^Key[A-Z]$/.test(code) ? code.slice(3) : /^Digit\d$/.test(code) ? code.slice(5) : /^F\d{1,2}$/.test(code) ? code : QUICK_KEYS[code];
  // A modifier alone is the start of a combination, not one.
  if (!key) return;
  const mods = [event.ctrlKey && 'Control', event.altKey && 'Alt', event.shiftKey && 'Shift', event.metaKey && (this.mac ? 'Command' : 'Super')].filter(Boolean);
  if (!mods.length && !/^F\d+$/.test(key)) return;
  this.recording = false;
  this.set({ shortcut: [...mods, key].join('+') });
 }

 words(shortcut) {
  return shortcut.split('+').map(part => part === 'Alt' && this.mac ? '⌥' : part === 'Super' && window.openghost.platform === 'linux' ? 'Super' : QUICK_NAMES[part] || part);
 }

 paint(state) {
  this.state = state;
  this.root.classList.toggle('is-off', !state.on);
  this.toggle.setAttribute('aria-checked', String(state.on));
  this.startup.hidden = !state.canStart;
  this.startupToggle.setAttribute('aria-checked', String(!!state.startup));
  this.keys.disabled = !state.on;
  this.keys.classList.toggle('is-recording', this.recording);
  this.keys.replaceChildren(...(this.recording ? [I18n.t('settings.quick.press')] : this.words(state.shortcut).map(word => Object.assign(document.createElement('kbd'), { textContent: word }))));
  const refused = state.refused || (state.failed && state.on ? state.shortcut : '');
  this.status.textContent = refused ? I18n.t('settings.quick.refused', { keys: this.words(refused).join(' + ') }) : '';
 }
}

// Whether the computer is kept awake while routines are on (desktop/awake.js), and whether a laptop's closed lid counts
// too. On a Mac the lid takes the administrator's password, so there it is the user's own choice and starts off.
class AwakeSettings {
 constructor(root) {
  this.root = root;
  this.bridge = window.openghost?.routines?.awake;
  if (!this.bridge) return;
  this.toggle = root.querySelector('.awake-switch');
  this.lid = root.querySelector('.awake-lid-switch');
  this.lidRow = root.querySelector('.awake-lid');
  this.toggle.addEventListener('click', () => this.set({ on: !this.state.on }));
  this.lid.addEventListener('click', () => this.set({ lid: !this.state.lid }));
  this.bridge.get().then(state => {
   if (!state) return;
   root.hidden = false;
   root.querySelector('.awake-lid-hint').textContent = I18n.t(`settings.awake.lid.${state.platform === 'darwin' ? 'mac' : state.platform === 'win32' ? 'windows' : 'linux'}`);
   this.paint(state);
  }).catch(() => {});
 }

 async set(changes) {
  const state = await this.bridge.set({ ...this.state, ...changes });
  if (state) this.paint(state);
 }

 paint(state) {
  this.state = state;
  this.root.classList.toggle('is-off', !state.on);
  this.toggle.setAttribute('aria-checked', String(state.on));
  this.lid.setAttribute('aria-checked', String(state.on && state.lid));
  this.lid.disabled = !state.on;
  this.lidRow.classList.toggle('is-off', !state.on);
 }
}

// Whether the agent may use the computer's mouse, keyboard and screen at all. Off until the user turns it on. Turning it
// on only offers the tools to the model: each click and keystroke still asks on a card of its own, in every mode.
const AUTOMATION_KEY = 'openghost.automation';

class AutomationSettings {
 constructor(root) {
  this.root = root;
  this.toggle = root.querySelector('.automation-switch');
  if (!window.openghost?.tools?.authorize) { root.hidden = true; return; }
  root.querySelector('.automation-note').textContent = I18n.t(`settings.automation.note.${window.openghost.platform === 'darwin' ? 'mac' : window.openghost.platform === 'win32' ? 'windows' : 'linux'}`);
  this.toggle.addEventListener('click', () => this.set(!this.on));
  this.paint();
 }

 get on() {
  try { return localStorage.getItem(AUTOMATION_KEY) === 'on'; } catch { return false; }
 }

 set(on) {
  try { localStorage.setItem(AUTOMATION_KEY, on ? 'on' : 'off'); } catch {}
  this.paint();
 }

 paint() {
  this.root.classList.toggle('is-off', !this.on);
  this.toggle.setAttribute('aria-checked', String(this.on));
 }
}

// Whether the agent may read and work other programs through the operating system's account of them — the
// accessibility tree, by way of the agent-desktop program. Off until the user turns it on, and turning it on only
// offers the tools: every click, keystroke, drag, window and quit still asks on a card of its own, in every mode.
// The program is not carried inside the app, because its per-platform binaries are some 30 MB: it is looked for where
// a person who installed it would have it, and when it is not there the one line that puts it there is said.
const DESKTOP_KEY = 'openghost.desktopUse';

class TreeSettings {
 constructor(root) {
  this.root = root;
  this.toggle = root.querySelector('.tree-switch');
  this.line = root.querySelector('.tree-state');
  this.found = null;
  if (!window.openghost?.tools?.authorize) { root.hidden = true; return; }
  root.querySelector('.tree-note').textContent = I18n.t(`settings.tree.note.${window.openghost.platform === 'darwin' ? 'mac' : window.openghost.platform === 'win32' ? 'windows' : 'linux'}`);
  this.toggle.addEventListener('click', () => this.set(!this.on));
  this.paint();
  // The answer comes from the same reading of the computer that the agent is given, so the words here and the words
  // a refused tool gives cannot disagree.
  window.AgentTools?.environment().then(env => { this.found = env?.agentDesktop || ''; this.paint(); }, () => { this.found = ''; this.paint(); });
 }

 get on() {
  try { return localStorage.getItem(DESKTOP_KEY) === 'on'; } catch { return false; }
 }

 set(on) {
  try { localStorage.setItem(DESKTOP_KEY, on ? 'on' : 'off'); } catch {}
  this.paint();
 }

 paint() {
  this.root.classList.toggle('is-off', !this.on);
  this.toggle.setAttribute('aria-checked', String(this.on));
  if (!this.line) return;
  // Nothing said until the search has answered: a blank line is truer than a guess about another program.
  if (this.found === null) { this.line.textContent = ''; return; }
  this.line.textContent = this.found ? I18n.t('settings.tree.found', { version: this.found }) : I18n.t('settings.tree.missing');
  this.root.classList.toggle('is-missing', !this.found);
 }
}

// The model that answers when the one you asked for is busy, or has spent its share of tokens for the day. Two
// choices sit here: the application's, which works with no chat touched, and one for this chat alone, which comes
// first. Naming them is all this page does — whether a switch is owed at all, and the one attempt it is worth, live
// in Providers.stream(), where the answer has not yet appeared on screen.
const ARROW = '<svg class="lang-arrows" viewBox="0 0 10 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.2 5.2L5 2.4l2.8 2.8M2.2 8.8L5 11.6l2.8-2.8"/></svg>';
const CHECK = '<svg class="lang-check" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.6 6.3l2.3 2.3 4.6-4.9"/></svg>';
const TICK = (() => {
 const box = document.createElement('div');
 box.innerHTML = CHECK;
 return box.firstElementChild;
})();

// Each pane's listeners go on once, however often this page is built again over the same elements.
const watched = new WeakSet();

class FallbackSettings {
 constructor(root, settingsOf, chatOf) {
  this.root = root;
  this.settingsOf = settingsOf;
  this.chatOf = chatOf;
  this.panes = new Map();
  for (const kind of ['global', 'chat']) {
   const button = root.querySelector(`.fallback-${kind}-button`);
   const menu = root.querySelector(`.fallback-${kind}-menu`);
   this.panes.set(kind, { button, menu, now: root.querySelector(`#settings-fallback${kind === 'chat' ? '-chat' : ''}-now`) });
  }
  this.watch(root);
  // The list of models changes when a key is added or a provider's list is read again.
  const settings = this.settings;
  const prior = settings?.onModels;
  if (settings) settings.onModels = () => { prior?.(); this.refresh(); };
  this.refresh();
 }

 // One press picks, and the list closes on whatever was chosen — including None, which is a choice of its own.
 watch(root) {
  if (watched.has(root)) return;
  watched.add(root);
  for (const pane of this.panes.values()) pane.glide = pane.menu.appendChild(document.createElement('span'));
  for (const [kind, { button, menu, glide }] of this.panes) {
   glide.className = 'lang-glide';
   glide.setAttribute('aria-hidden', 'true');
   glide.style.opacity = '0';
   button.addEventListener('click', () => {
    this.fill(kind);
    menu.showPopover();
    // The rows have sizes only once the list is open, so the highlight is put on the chosen one here — and the
    // keyboard starts there too, rather than at the top of the list.
    const chosen = menu.querySelector('.lang-option[aria-selected="true"]');
    this.move(glide, chosen);
    chosen?.focus({ preventScroll: true });
    chosen?.scrollIntoView({ block: 'nearest' });
   });
   menu.addEventListener('toggle', event => button.setAttribute('aria-expanded', String(event.newState === 'open')));
   menu.addEventListener('pointerover', event => this.move(glide, event.target.closest('.lang-option')));
   menu.addEventListener('pointerleave', () => { glide.style.opacity = '0'; });
   menu.addEventListener('focusin', event => this.move(glide, event.target.closest('.lang-option')));
   menu.addEventListener('click', event => {
    const option = event.target.closest('.lang-option');
    if (!option) return;
    this.pick(kind, option.dataset.model || '');
    menu.hidePopover();
   });
   // The rows glide on the keyboard as they do under the pointer: the list is a real one, and a person choosing a
   // safety net with the keys should not have to reach for the mouse to finish it.
   menu.addEventListener('keydown', event => {
    if (event.key === 'Escape') return menu.hidePopover();
    const rows = [...menu.querySelectorAll('.lang-option')];
    if (!rows.length || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const at = rows.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1
     : event.key === 'ArrowDown' ? (at < 0 ? 0 : (at + 1) % rows.length)
      : (at <= 0 ? rows.length - 1 : at - 1);
    rows[next].focus();
   });
  }
 }

 get settings() { return this.settingsOf(); }

 // The chat is built after this page is, so asking before then means only that no chat is open yet — the same answer
 // a window without one would give.
 get chat() {
  try { return this.chatOf(); } catch { return null; }
 }

 // A row of the list: the model's name, and beside it the provider it belongs to, because two providers sell the same
 // model under the same name and the difference is the whole point of choosing one.
 option(id, name, note, chosen) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'lang-option';
  button.setAttribute('role', 'option');
  button.tabIndex = -1;
  button.dataset.model = id;
  button.setAttribute('aria-selected', String(id === chosen));
  const title = document.createElement('span');
  title.className = 'lang-name';
  title.textContent = name;
  const under = document.createElement('span');
  under.className = 'lang-note';
  under.textContent = note;
  // The tick the language list uses, so the choice in use is marked the same way everywhere. A model's name is what
  // its provider sent, so it goes in as text and never through markup.
  button.append(title, under, TICK.cloneNode(true));
  return button;
 }

 fill(kind) {
  const { menu, glide } = this.panes.get(kind);
  const models = this.settings?.models || [];
  const chosen = this.shown(kind);
  // The rows are written anew each time the button is pressed, because a key added since the last look changes them;
  // the highlight is the one element that stays and simply moves to the row it is on.
  menu.replaceChildren(
   this.option('', I18n.t('settings.fallback.none'), '', chosen),
   ...models.map(model => this.option(model.id, model.name || model.id, window.Providers?.NAMES?.[model.provider] || model.provider, chosen)),
   glide,
  );
 }

 // The one highlight of the list, set to the row the pointer or the keyboard is on.
 move(glide, option) {
  if (!option) return;
  glide.style.opacity = '1';
  glide.style.height = `${option.offsetHeight}px`;
  glide.style.transform = `translateY(${option.offsetTop}px)`;
 }

 // What the button says. For this chat, a chat that named none says None even when the application named a model —
 // that is what an override means, and hiding it would be a lie about what will happen.
 shown(kind) {
  if (kind === 'global') return this.settings?.fallback || '';
  const conv = this.chat?.active;
  if (!conv) return '';
  const own = conv.record?.fallback ?? conv.fallback;
  return own === undefined ? (this.settings?.fallback || '') : own;
 }

 pick(kind, id) {
  if (kind === 'global') this.settings?.setFallbackModel(id);
  else if (this.chat) this.chat.setFallback(id);
  this.refresh();
 }

 refresh() {
  const conv = this.chat?.active;
  this.root.querySelector('.fallback-chat-head').hidden = !conv;
  this.root.querySelector('.fallback-chat-hint').hidden = !conv;
  for (const kind of ['global', 'chat']) {
   const { now } = this.panes.get(kind);
   const id = this.shown(kind);
   const model = id ? this.settings?.find(id) : null;
   now.textContent = model ? (model.name || model.id) : I18n.t('settings.fallback.none');
  }
 }
}

class GeneralSettings {
 constructor({ root, context, chat, settings }) {
  this.root = root;
  this.context = context;
  this.rows = new Map();
  this.depth = 0;
  this.statusTimer = 0;
  const t = key => escapeHtml(I18n.t(key));
  root.innerHTML = `
   <p class="settings-lead">${t('settings.general.lead')}</p>
   <section class="general-block general-language"></section>
   <section class="general-block">
    <div class="general-head">
     <label class="settings-label" for="settings-instructions">${t('settings.instructions')}</label>
     <span class="general-count" aria-hidden="true"></span>
    </div>
    <p class="settings-hint">${t('settings.instructions.hint')}</p>
    <div class="general-field"><textarea id="settings-instructions" class="general-input" rows="4" maxlength="${context.limits.instructions}" spellcheck="true" placeholder="${t('settings.instructions.placeholder')}"></textarea></div>
   </section>
   <section class="general-block general-files-block">
    <div class="general-head"><span class="settings-label" id="settings-files-label">${t('settings.files')}</span></div>
    <p class="settings-hint">${t('settings.files.hint')}</p>
    <ul class="general-files" aria-labelledby="settings-files-label"></ul>
    <button type="button" class="general-drop">${PLUS}<span>${t('settings.files.drop')}</span></button>
    <p class="settings-status general-status" role="status"></p>
    <input class="general-picker" type="file" multiple hidden>
   </section>
   <section class="general-block general-chatsfolder">
    <div class="general-head">
     <span class="settings-label">${t('settings.chatsfolder')}</span>
     <button type="button" class="settings-button general-chatsfolder-pick">${t('settings.chatsfolder.pick')}</button>
    </div>
    <p class="settings-hint">${t('settings.chatsfolder.hint')}</p>
    <p class="general-chatsfolder-path"></p>
    <p class="settings-status general-chatsfolder-status" role="status" hidden></p>
   </section>
   <section class="general-block general-quick" hidden>
    <div class="general-head quick-head">
     <span class="settings-label" id="settings-quick-label">${t('settings.quick')}</span>
     <button type="button" class="memory-switch quick-switch" role="switch" aria-labelledby="settings-quick-label"><span class="memory-switch-knob"></span></button>
    </div>
    <p class="settings-hint">${t('settings.quick.hint')}</p>
    <div class="quick-row"><span class="quick-row-label" id="settings-quick-keys">${t('settings.quick.keys')}</span><button type="button" class="quick-keys" aria-labelledby="settings-quick-keys"></button></div>
    <div class="quick-row quick-startup" hidden><span class="quick-row-label" id="settings-quick-startup">${t('settings.quick.startup')}</span><button type="button" class="memory-switch quick-startup-switch" role="switch" aria-labelledby="settings-quick-startup"><span class="memory-switch-knob"></span></button></div>
    <p class="settings-status quick-status" role="status"></p>
   </section>
   <section class="general-block general-awake" hidden>
    <div class="general-head quick-head">
     <span class="settings-label" id="settings-awake-label">${t('settings.awake')}</span>
     <button type="button" class="memory-switch awake-switch" role="switch" aria-labelledby="settings-awake-label"><span class="memory-switch-knob"></span></button>
    </div>
    <p class="settings-hint">${t('settings.awake.hint')}</p>
    <div class="quick-row awake-lid"><span class="quick-row-label" id="settings-awake-lid">${t('settings.awake.lid')}</span><button type="button" class="memory-switch awake-lid-switch" role="switch" aria-labelledby="settings-awake-lid"><span class="memory-switch-knob"></span></button></div>
    <p class="settings-hint awake-lid-hint"></p>
   </section>
   <section class="general-block general-automation">
    <div class="general-head quick-head">
     <span class="settings-label" id="settings-automation-label">${t('settings.automation')}</span>
     <button type="button" class="memory-switch automation-switch" role="switch" aria-labelledby="settings-automation-label"><span class="memory-switch-knob"></span></button>
    </div>
    <p class="settings-hint">${t('settings.automation.hint')}</p>
    <p class="settings-hint automation-note"></p>
   </section>
   <section class="general-block general-tree">
    <div class="general-head quick-head">
     <span class="settings-label" id="settings-tree-label">${t('settings.tree')}</span>
     <button type="button" class="memory-switch tree-switch" role="switch" aria-labelledby="settings-tree-label"><span class="memory-switch-knob"></span></button>
    </div>
    <p class="settings-hint">${t('settings.tree.hint')}</p>
    <p class="settings-hint tree-note"></p>
    <p class="settings-hint tree-state"></p>
   </section>
   <section class="general-block general-fallback">
    <div class="general-head quick-head">
     <span class="settings-label" id="settings-fallback-label">${t('settings.fallback')}</span>
     <button type="button" class="lang-button fallback-global-button" aria-haspopup="listbox" aria-expanded="false" aria-labelledby="settings-fallback-label settings-fallback-now"><span id="settings-fallback-now">${t('settings.fallback.none')}</span>${ARROW}</button>
    </div>
    <p class="settings-hint">${t('settings.fallback.hint')}</p>
    <div class="general-head quick-head fallback-chat-head">
     <span class="settings-label" id="settings-fallback-chat-label">${t('settings.fallback.chat')}</span>
     <button type="button" class="lang-button fallback-chat-button" aria-haspopup="listbox" aria-expanded="false" aria-labelledby="settings-fallback-chat-label settings-fallback-chat-now"><span id="settings-fallback-chat-now">${t('settings.fallback.none')}</span>${ARROW}</button>
    </div>
    <p class="settings-hint fallback-chat-hint">${t('settings.fallback.chat.hint')}</p>
    <div class="lang-menu fallback-global-menu" popover role="listbox" aria-labelledby="settings-fallback-label"></div>
    <div class="lang-menu fallback-chat-menu" popover role="listbox" aria-labelledby="settings-fallback-chat-label"></div>
   </section>
   <section class="general-block general-access" hidden>
    <div class="general-head">
     <span class="settings-label">${t('settings.access')}</span>
     <span class="general-access-state" role="status"></span>
    </div>
    <p class="settings-hint">${t('settings.access.hint')}</p>
    <div class="general-access-actions">
     <button type="button" class="settings-button general-access-open">${t('settings.access.open')}</button>
     <button type="button" class="settings-button general-access-restart">${t('settings.access.restart')}</button>
    </div>
    <p class="settings-hint general-access-note">${t('settings.access.restart.hint')}</p>
   </section>`;
  new LanguageSettings(root.querySelector('.general-language'));
  this.quick = new QuickSettings(root.querySelector('.general-quick'));
  this.awake = new AwakeSettings(root.querySelector('.general-awake'));
  new AutomationSettings(root.querySelector('.general-automation'));
  new TreeSettings(root.querySelector('.general-tree'));
  // The two fallback choices read the live settings and the live chat each time they are asked, because both change
  // while this page stays open.
  this.fallback = new FallbackSettings(root.querySelector('.general-fallback'), settings, chat);
  // A Mac asks the user itself before the app first opens some folders. The block is there only on a Mac.
  this.access = root.querySelector('.general-access');
  root.querySelector('.general-access-open').addEventListener('click', () => window.openghost?.access?.open());
  root.querySelector('.general-access-restart').addEventListener('click', () => window.openghost?.access?.restart());
  window.addEventListener('focus', () => this.paintAccess());
  this.paintAccess();
  this.input = root.querySelector('.general-input');
  this.count = root.querySelector('.general-count');
  this.list = root.querySelector('.general-files');
  this.block = root.querySelector('.general-files-block');
  this.status = root.querySelector('.general-status');
  this.picker = root.querySelector('.general-picker');
  // The field grows with the text and the box around it follows on a spring, like the composer.
  new SmoothHeight(root.querySelector('.general-field'), this.input);
  this.input.addEventListener('input', () => {
   context.setInstructions(this.input.value);
   this.paintCount();
  });
  root.querySelector('.general-drop').addEventListener('click', () => this.picker.click());
  // Where the chats without a project folder are kept. A new folder takes what was already there along; a name
  // already at the other end is left where it is, and the line under the path says how many were.
  this.chatsFolder = root.querySelector('.general-chatsfolder-path');
  this.chatsNote = root.querySelector('.general-chatsfolder-status');
  root.querySelector('.general-chatsfolder-pick').addEventListener('click', () => this.pickChatsFolder());
  window.openghost?.chatsFolder?.().then(folder => folder && this.showChatsFolder(folder)).catch(() => {});
  window.openghost?.onChatsFolder?.(folder => this.showChatsFolder(folder));
  this.picker.addEventListener('change', () => {
   this.add(this.picker.files);
   this.picker.value = '';
  });
  this.list.addEventListener('click', event => {
   const button = event.target.closest('.general-file-remove');
   if (button) this.remove(button.closest('.general-file').dataset.id);
  });
  this.block.addEventListener('dragenter', event => this.onDrag(event, 1));
  this.block.addEventListener('dragleave', event => this.onDrag(event, -1));
  this.block.addEventListener('dragover', event => {
   if (!hasFiles(event)) return;
   event.preventDefault();
   event.dataTransfer.dropEffect = 'copy';
  });
  this.block.addEventListener('drop', event => {
   if (!hasFiles(event)) return;
   event.preventDefault();
   this.depth = 0;
   this.block.classList.remove('is-dropping');
   this.add(event.dataTransfer.files);
  });
  context.onChange(() => this.render());
  context.ready.then(() => {
   this.input.value = context.instructions;
   this.paintCount();
   this.render(false);
  });
 }

 onDrag(event, step) {
  if (!hasFiles(event)) return;
  event.preventDefault();
  this.depth = Math.max(0, this.depth + step);
  this.block.classList.toggle('is-dropping', this.depth > 0);
 }

 // The count shows only near the limit, where it matters.
 paintCount() {
  const length = this.input.value.length, max = this.context.limits.instructions;
  this.count.textContent = length > max * 0.85 ? `${length.toLocaleString('en-US')} / ${max.toLocaleString('en-US')}` : '';
 }

 // The path is shown as it stands on the disk; the line under it says what came along when it was pointed elsewhere.
 showChatsFolder(folder, note = '') {
  this.chatsFolder.textContent = folder;
  this.chatsFolder.title = folder;
  this.chatsNote.hidden = !note;
  this.chatsNote.textContent = note;
 }

 async pickChatsFolder() {
  const picked = await window.openghost?.pickFolder?.().catch(() => null);
  if (!picked?.path) return;
  const said = await window.openghost.setChatsFolder(picked.path).catch(() => null);
  if (!said) return this.showChatsFolder(this.chatsFolder.textContent, I18n.t('settings.chatsfolder.failed'));
  if (said.failure) return this.showChatsFolder(this.chatsFolder.textContent, said.failure);
  const notes = [];
  if (said.along) notes.push(I18n.t('settings.chatsfolder.moved', { n: said.along }));
  if (said.left?.length) notes.push(I18n.t('settings.chatsfolder.left', { n: said.left.length }));
  this.showChatsFolder(said.path, notes.join(' '));
 }

 async add(files) {
  if (!files?.length) return;
  this.say('');
  const skipped = await this.context.add(files);
  if (!skipped.length) return;
  const first = skipped[0];
  const text = first.reason === 'count'
   ? I18n.t('settings.files.count', { count: this.context.limits.files })
   : I18n.t(`settings.files.${first.reason}`, { name: first.name });
  this.say(text, 'error');
 }

 remove(id) {
  this.say('');
  this.context.remove(id);
 }

 say(text, tone = '') {
  clearTimeout(this.statusTimer);
  this.status.textContent = text;
  this.status.dataset.tone = tone;
  if (text) this.statusTimer = setTimeout(() => this.say(''), STATUS_TIME);
 }

 meta(file) {
  const info = FileKinds.describe(file.name);
  const parts = [info.name, FileKinds.formatSize(file.size)];
  if (file.kind === 'text') parts.push(I18n.t('settings.files.tokens', { count: tokens(file.chars) }));
  else if (file.kind === 'image' && file.width) parts.push(`${file.width}×${file.height}`);
  else if (file.kind === 'none') parts.push(I18n.t('settings.files.path'));
  return parts.join(' · ');
 }

 row(file) {
  const el = document.createElement('li');
  el.className = 'general-file';
  el.dataset.id = file.id;
  const url = file.kind === 'image' ? this.context.payloads.get(file.id)?.url : '';
  const art = url ? `<img class="general-file-thumb" src="${url}" alt="">` : FileKinds.icon(FileKinds.describe(file.name));
  el.innerHTML = `
   ${art}
   <span class="general-file-text">
    <span class="general-file-name"></span>
    <span class="general-file-meta"></span>
   </span>
   <button type="button" class="general-file-remove">${CROSS}</button>`;
  el.querySelector('.general-file-name').textContent = file.name;
  el.querySelector('.general-file-name').title = file.path || file.name;
  el.querySelector('.general-file-meta').textContent = this.meta(file);
  el.querySelector('.general-file-remove').setAttribute('aria-label', I18n.t('settings.files.remove', { name: file.name }));
  return el;
 }

 // New files slide open into the list and removed ones fold away; the rest stay put.
 // Whether macOS already lets OpenGhost into every folder; asked anew whenever the window comes back, since the user
 // changes it in the system's own settings.
 async paintAccess() {
  const state = await window.openghost?.access?.state().catch(() => null);
  this.access.hidden = !state;
  if (!state) return;
  this.access.classList.toggle('is-given', state.full);
  this.access.querySelector('.general-access-state').textContent = I18n.t(state.full ? 'settings.access.on' : 'settings.access.off');
 }

 render(animate = true) {
  const files = this.context.files, keep = new Set(files.map(file => file.id));
  const motion = animate && !reducedMotion();
  for (const [id, el] of this.rows) {
   if (keep.has(id)) continue;
   this.rows.delete(id);
   if (!motion) { el.remove(); continue; }
   el.style.pointerEvents = 'none';
   el.animate([{ height: `${el.offsetHeight}px`, opacity: 1, filter: 'blur(0)' }, { ...FOLDED, opacity: 0, filter: 'blur(4px)', marginTop: '-6px' }], { ...ROW, duration: 320, fill: 'forwards' })
    .finished.then(() => el.remove(), () => el.remove());
  }
  let before = null;
  for (const file of [...files].reverse()) {
   let el = this.rows.get(file.id);
   if (!el) {
    el = this.row(file);
    this.rows.set(file.id, el);
    this.list.insertBefore(el, before);
    if (motion) el.animate([{ ...FOLDED, opacity: 0, transform: 'translateY(-6px)', filter: 'blur(4px)' }, { height: `${el.offsetHeight}px`, opacity: 1, transform: 'none', filter: 'blur(0)' }], ROW);
   } else if (el.nextElementSibling !== before) {
    this.list.insertBefore(el, before);
   }
   before = el;
  }
 }
}

window.GeneralSettings = GeneralSettings;
})();
