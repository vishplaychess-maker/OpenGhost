(() => {
'use strict';

// Settings → Model. The models a person chose, gathered in one place instead of being scattered over the composer's
// menu and a fallback line under General: profiles at the top, and under them the choices that profile stands for — the
// provider and model a new chat starts on, and how hard that model thinks. A chat already open keeps its own model and
// effort (the composer's menu still works on it); only new chats and drafts take what is here.
const ARROW = '<svg class="lang-arrows" viewBox="0 0 10 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.2 5.2L5 2.4l2.8 2.8M2.2 8.8L5 11.6l2.8-2.8"/></svg>';
const CHECK = '<svg class="lang-check" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.6 6.3l2.3 2.3 4.6-4.9"/></svg>';
const TICK = (() => {
 const box = document.createElement('div');
 box.innerHTML = CHECK;
 return box.firstElementChild;
})();
// The grip of a fallback row: two columns of dots, which is what a list that can be dragged is marked with.
const GRIP = '<svg viewBox="0 0 10 16" fill="currentColor" aria-hidden="true"><circle cx="3" cy="3.5" r="1.3"/><circle cx="7" cy="3.5" r="1.3"/><circle cx="3" cy="8" r="1.3"/><circle cx="7" cy="8" r="1.3"/><circle cx="3" cy="12.5" r="1.3"/><circle cx="7" cy="12.5" r="1.3"/></svg>';
// The same three fields on every list, so one watch covers them all.
const watched = new WeakSet();

class ModelSettings {
 constructor({ root, settings }) {
  this.root = root;
  this.settings = settings;
  this.draft = null;
  this.panes = new Map();
  this.root.innerHTML = `
   <nav class="model-subnav" role="tablist" aria-label="${I18n.t('settings.modelSection')}">
    <button type="button" class="model-subtab is-current" role="tab" aria-selected="true" data-pane="main">${I18n.t('settings.model.main')}</button>
    <button type="button" class="model-subtab" role="tab" aria-selected="false" data-pane="fallback">${I18n.t('settings.model.fallbacks')}</button>
   </nav>
   <div class="model-pane" data-pane="main">
   <section class="general-block model-profiles-block">
    <div class="general-head">
     <span class="settings-label" id="settings-model-profiles-label">${I18n.t('settings.model.profiles')}</span>
     <button type="button" class="settings-button model-profile-new">${I18n.t('settings.model.new')}</button>
    </div>
    <p class="settings-hint">${I18n.t('settings.model.profiles.hint')}</p>
    <ul class="model-profile-list" role="radiogroup" aria-labelledby="settings-model-profiles-label"></ul>
    <form class="model-profile-name" hidden>
     <input class="settings-key settings-field model-profile-input" type="text" maxlength="40" autocomplete="off" spellcheck="false" aria-label="${I18n.t('settings.model.name')}" placeholder="${I18n.t('settings.model.name')}">
     <button type="submit" class="settings-button is-primary">${I18n.t('settings.model.apply')}</button>
     <button type="button" class="settings-button model-profile-cancel">${I18n.t('settings.model.cancel')}</button>
    </form>
   </section>
   <section class="general-block model-choice-block">
    <div class="general-head">
     <span class="settings-label">${I18n.t('settings.model.this')}</span>
     <button type="button" class="settings-button model-profile-rename">${I18n.t('settings.model.rename')}</button>
     <button type="button" class="settings-button model-profile-delete">${I18n.t('settings.model.delete')}</button>
     <button type="button" class="settings-button is-primary model-apply">${I18n.t('settings.model.apply')}</button>
    </div>
    <div class="quick-row"><span class="quick-row-label">${I18n.t('settings.model.provider')}</span><button type="button" class="lang-button model-provider-button" aria-haspopup="listbox" aria-expanded="false"><span class="model-provider-now"></span>${ARROW}</button></div>
    <div class="quick-row"><span class="quick-row-label">${I18n.t('settings.model.model')}</span><button type="button" class="lang-button model-model-button" aria-haspopup="listbox" aria-expanded="false"><span class="model-model-now"></span>${ARROW}</button></div>
    <div class="quick-row"><span class="quick-row-label">${I18n.t('settings.model.reasoning')}</span><button type="button" class="lang-button model-reasoning-button" aria-haspopup="listbox" aria-expanded="false"><span class="model-reasoning-now"></span>${ARROW}</button></div>
    <div class="quick-row model-temperature-row">
     <span class="quick-row-label">${I18n.t('settings.model.temperature')}</span>
     <div class="model-temperature">
      <input type="range" class="model-temperature-range" min="0" max="2" step="0.1" aria-label="${I18n.t('settings.model.temperature')}">
      <span class="model-temperature-now"></span>
      <button type="button" class="settings-button model-temperature-reset">${I18n.t('settings.model.temperature.reset')}</button>
     </div>
    </div>
    <p class="settings-hint model-temperature-hint" hidden>${I18n.t('settings.model.temperature.unsupported')}</p>
    <div class="quick-row"><span class="quick-row-label">${I18n.t('settings.model.context')}</span><input class="settings-key settings-field model-context" type="number" min="0" step="1024" inputmode="numeric" aria-label="${I18n.t('settings.model.context')}"></div>
    <p class="settings-hint model-context-hint">${I18n.t('settings.model.context.hint')}</p>
    <p class="settings-status model-status" role="status"></p>
    <div class="lang-menu model-provider-menu" popover role="listbox" aria-label="${I18n.t('settings.model.provider')}"></div>
    <div class="lang-menu model-model-menu" popover role="listbox" aria-label="${I18n.t('settings.model.model')}"></div>
    <div class="lang-menu model-reasoning-menu" popover role="listbox" aria-label="${I18n.t('settings.model.reasoning')}"></div>
   </section>
   </div>
   <div class="model-pane" data-pane="fallback" hidden>
    <section class="general-block model-fallback-block">
     <div class="general-head">
      <span class="settings-label" id="settings-model-fallback-label">${I18n.t('settings.model.fallbacks')}</span>
      <button type="button" class="settings-button model-fallback-add">${I18n.t('settings.model.fallback.add')}</button>
     </div>
     <p class="settings-hint">${I18n.t('settings.model.fallbacks.hint')}</p>
     <ol class="model-fallback-list" aria-labelledby="settings-model-fallback-label"></ol>
     <p class="settings-hint model-fallback-empty">${I18n.t('settings.model.fallbacks.empty')}</p>
     <div class="lang-menu model-fallback-menu" popover role="listbox" aria-label="${I18n.t('settings.model.fallback.add')}"></div>
    </section>
   </div>`;
  this.list = this.root.querySelector('.model-profile-list');
  this.status = this.root.querySelector('.model-status');
  this.fallbackList = this.root.querySelector('.model-fallback-list');
  this.fallbackEmpty = this.root.querySelector('.model-fallback-empty');
  this.fallbackMenu = this.root.querySelector('.model-fallback-menu');
  this.root.querySelectorAll('.model-subtab').forEach(button => button.addEventListener('click', () => this.showPane(button.dataset.pane)));
  this.root.querySelector('.model-fallback-add').addEventListener('click', () => this.openFallbackMenu());
  this.fallbackMenu.addEventListener('click', event => {
   const option = event.target.closest('.lang-option');
   if (!option) return;
   this.fallbackMenu.hidePopover();
   if (option.dataset.value) this.addFallback(option.dataset.value);
  });
  this.fallbackList.addEventListener('click', event => {
   const remove = event.target.closest('.model-fallback-remove');
   if (remove) this.removeFallback(Number(remove.dataset.at));
  });
  this.fallbackList.addEventListener('keydown', event => {
   const row = event.target.closest('.model-fallback-row');
   if (!row || !['ArrowUp', 'ArrowDown'].includes(event.key) || !event.altKey) return;
   event.preventDefault();
   this.moveFallback(Number(row.dataset.at), event.key === 'ArrowUp' ? -1 : 1);
  });
  this.fallbackList.addEventListener('dragstart', event => {
   const row = event.target.closest('.model-fallback-row');
   if (!row) return;
   this.dragged = Number(row.dataset.at);
   row.classList.add('is-dragging');
   event.dataTransfer.effectAllowed = 'move';
   // Firefox needs some payload before a drag starts at all; Chromium does not read it back here.
   event.dataTransfer.setData('text/plain', row.dataset.at);
  });
  this.fallbackList.addEventListener('dragend', () => {
   this.dragged = null;
   for (const row of this.fallbackList.querySelectorAll('.is-dragging, .is-over')) row.classList.remove('is-dragging', 'is-over');
  });
  this.fallbackList.addEventListener('dragover', event => {
   const row = event.target.closest('.model-fallback-row');
   if (!row || this.dragged === null) return;
   event.preventDefault();
   event.dataTransfer.dropEffect = 'move';
   for (const other of this.fallbackList.querySelectorAll('.is-over')) if (other !== row) other.classList.remove('is-over');
   row.classList.add('is-over');
  });
  this.fallbackList.addEventListener('drop', event => {
   const row = event.target.closest('.model-fallback-row');
   if (!row || this.dragged === null) return;
   event.preventDefault();
   this.moveFallback(this.dragged, Number(row.dataset.at) - this.dragged);
  });
  this.nameForm = this.root.querySelector('.model-profile-name');
  this.nameInput = this.root.querySelector('.model-profile-input');
  this.nameForm.addEventListener('submit', event => {
   event.preventDefault();
   this.commitName();
  });
  this.root.querySelector('.model-profile-cancel').addEventListener('click', () => this.closeName());
  this.root.querySelector('.model-profile-new').addEventListener('click', () => this.openName('create'));
  this.root.querySelector('.model-profile-rename').addEventListener('click', () => this.openName('rename'));
  this.root.querySelector('.model-profile-delete').addEventListener('click', () => this.remove());
  this.root.querySelector('.model-apply').addEventListener('click', () => this.apply());
  this.slider = this.root.querySelector('.model-temperature-range');
  this.sliderNow = this.root.querySelector('.model-temperature-now');
  this.contextInput = this.root.querySelector('.model-context');
  this.slider.addEventListener('input', () => {
   this.draft = { ...this.draft, temperature: Number(this.slider.value) };
   this.dirty = true;
   this.showChoice();
  });
  this.root.querySelector('.model-temperature-reset').addEventListener('click', () => {
   this.draft = { ...this.draft, temperature: null };
   this.dirty = true;
   this.showChoice();
  });
  this.contextInput.addEventListener('input', () => {
   const value = Math.max(0, Math.round(Number(this.contextInput.value) || 0));
   this.draft = { ...this.draft, contextWindow: value };
   this.dirty = true;
  });
  for (const kind of ['provider', 'model', 'reasoning']) this.pane(kind);
  // A key added or a provider's list read again changes what these lists can offer.
  const prior = this.settings.onModels;
  this.settings.onModels = () => { prior?.(); this.sync(); };
  this.sync();
 }

 // One of the three lists of the page: its button, its menu, and what the button says.
 pane(kind) {
  const button = this.root.querySelector(`.model-${kind}-button`);
  const menu = this.root.querySelector(`.model-${kind}-menu`);
  const now = this.root.querySelector(`.model-${kind}-now`);
  const glide = menu.appendChild(document.createElement('span'));
  glide.className = 'lang-glide';
  glide.setAttribute('aria-hidden', 'true');
  this.panes.set(kind, { button, menu, now, glide });
  if (watched.has(menu)) return;
  watched.add(menu);
  button.addEventListener('click', () => {
   this.fill(kind);
   menu.showPopover();
   const chosen = menu.querySelector('.lang-option[aria-selected="true"]');
   this.point(glide, chosen);
   chosen?.focus({ preventScroll: true });
   chosen?.scrollIntoView({ block: 'nearest' });
  });
  menu.addEventListener('toggle', event => button.setAttribute('aria-expanded', String(event.newState === 'open')));
  menu.addEventListener('pointerover', event => this.point(glide, event.target.closest('.lang-option')));
  menu.addEventListener('pointerleave', () => { glide.style.opacity = '0'; });
  menu.addEventListener('focusin', event => this.point(glide, event.target.closest('.lang-option')));
  menu.addEventListener('click', event => {
   const option = event.target.closest('.lang-option');
   if (!option) return;
   this.choose(kind, option.dataset.value);
   menu.hidePopover();
  });
  menu.addEventListener('keydown', event => {
   if (event.key === 'Escape') return menu.hidePopover();
   const rows = [...menu.querySelectorAll('.lang-option')];
   if (!rows.length || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
   event.preventDefault();
   const at = rows.indexOf(document.activeElement);
   const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1
    : event.key === 'ArrowDown' ? (at < 0 ? 0 : (at + 1) % rows.length)
     : (at <= 0 ? rows.length - 1 : at - 1);
   rows[next].focus({ preventScroll: true });
   rows[next].scrollIntoView({ block: 'nearest' });
  });
 }

 point(glide, option) {
  if (!option) return;
  glide.style.opacity = '1';
  glide.style.height = `${option.offsetHeight}px`;
  glide.style.transform = `translateY(${option.offsetTop}px)`;
 }

 option(value, name, note, chosen) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'lang-option';
  button.setAttribute('role', 'option');
  button.tabIndex = -1;
  button.dataset.value = value;
  button.setAttribute('aria-selected', String(value === chosen));
  const title = document.createElement('span');
  title.className = 'lang-name';
  title.textContent = name;
  const under = document.createElement('span');
  under.className = 'lang-note';
  under.textContent = note;
  // Names come from providers and from the person: they are written as text, never as markup.
  button.append(title, under, TICK.cloneNode(true));
  return button;
 }

 // What the page is showing: the profile in use, and the choices being made for it, which Apply writes down.
 get profile() { return this.settings.profiles.active(); }
 get providers() { return this.settings.connectedProviders; }

 modelsOf(provider) { return (this.settings.models || []).filter(model => model.provider === provider); }

 draftOf(profile) {
  const model = profile?.model && this.settings.find(profile.model);
  const provider = profile?.provider || model?.provider || this.settings.find(this.settings.model)?.provider || this.providers[0] || '';
  const list = this.modelsOf(provider);
  const chosen = list.find(item => item.id === profile?.model) || list[0];
  return {
   provider,
   model: chosen?.id || profile?.model || '',
   reasoning: profile?.reasoning || '',
   temperature: typeof profile?.temperature === 'number' ? profile.temperature : null,
   contextWindow: Number(profile?.contextWindow) > 0 ? Math.round(Number(profile.contextWindow)) : 0,
  };
 }

 sync() {
  const profile = this.profile;
  if (!profile) return;
  this.drawProfiles();
  // A page coming back to a profile it was not editing takes that profile's choices; one that already is shows what
  // was picked here until Apply writes it. Choices made on the page are marked, so a list arriving late (a provider's
  // models read after this page was drawn) does not wipe them, while a page nobody has touched follows the list.
  if (!this.draft || this.draft.profile !== profile.id || !this.dirty) {
   this.draft = { profile: profile.id, ...this.draftOf(profile) };
   this.dirty = false;
  }
  this.showChoice();
  this.drawFallbacks();
  this.paintName(profile);
 }

 drawProfiles() {
  const active = this.profile?.id;
  this.list.replaceChildren(...this.settings.profiles.list().map(profile => {
   const row = document.createElement('li');
   const button = document.createElement('button');
   button.type = 'button';
   button.className = 'model-profile';
   button.setAttribute('role', 'radio');
   button.setAttribute('aria-checked', String(profile.id === active));
   button.dataset.profile = profile.id;
   const name = document.createElement('span');
   name.className = 'lang-name';
   name.textContent = this.settings.profiles.name(profile);
   const note = document.createElement('span');
   note.className = 'lang-note';
   note.textContent = this.describe(profile);
   button.append(name, note, TICK.cloneNode(true));
   button.addEventListener('click', () => this.activate(profile.id));
   row.append(button);
   return row;
  }));
 }

 describe(profile) {
  const model = profile.model ? this.settings.find(profile.model) : null;
  const provider = window.Providers?.NAMES?.[profile.provider || model?.provider || ''] || '';
  if (!model && !profile.model) return I18n.t('settings.model.none');
  return `${provider}${provider ? ' · ' : ''}${model?.name || profile.model}`;
 }

 async activate(id) {
  if (!await this.settings.setProfile(id)) return;
  this.draft = null;
  this.sync();
 }

 showChoice() {
  const draft = this.draft;
  this.panes.get('provider').now.textContent = window.Providers?.NAMES?.[draft.provider] || draft.provider || I18n.t('settings.model.none');
  const model = this.settings.find(draft.model);
  this.panes.get('model').now.textContent = model?.name || draft.model || I18n.t('settings.model.none');
  this.panes.get('reasoning').now.textContent = draft.reasoning ? I18n.t(`effort.${draft.reasoning}`) : I18n.t('settings.model.reasoning.default');
  // The temperature is the profile's own wish, so it says "model default" until one is set; an engine that cannot carry
  // one shows why rather than a slider that would do nothing.
  const takes = window.Providers?.takesTemperature?.(draft.provider) !== false;
  this.slider.disabled = !takes;
  this.root.querySelector('.model-temperature-hint').hidden = takes;
  this.slider.value = String(typeof draft.temperature === 'number' ? draft.temperature : 1);
  this.sliderNow.textContent = typeof draft.temperature === 'number' ? draft.temperature.toFixed(1) : I18n.t('settings.model.temperature.default');
  this.root.querySelector('.model-temperature-reset').hidden = typeof draft.temperature !== 'number';
  this.contextInput.value = String(draft.contextWindow || 0);
  this.contextInput.placeholder = String(model?.context || 0);
  const profile = this.profile;
  this.root.querySelector('.model-profile-rename').hidden = profile?.id === 'default';
  this.root.querySelector('.model-profile-delete').hidden = profile?.id === 'default';
 }

 fill(kind) {
  const { menu, glide } = this.panes.get(kind);
  const draft = this.draft;
  let rows;
  if (kind === 'provider') {
   rows = this.providers.map(provider => this.option(provider, window.Providers?.NAMES?.[provider] || provider, '', provider === draft.provider));
  } else if (kind === 'model') {
   // The window a model works in is the second line: it is how two models with the same name and price differ.
   rows = this.modelsOf(draft.provider).map(model => this.option(model.id, model.name || model.id, model.context ? `${Math.round(model.context / 1000)}k` : '', model.id === draft.model));
  } else {
   const model = this.settings.find(draft.model);
   const efforts = model?.efforts?.length ? model.efforts : ['none', 'low', 'high', 'max'];
   rows = [
    this.option('', I18n.t('settings.model.reasoning.default'), model?.defaultEffort ? I18n.t(`effort.${model.defaultEffort}`) : '', !draft.reasoning),
    ...efforts.map(level => this.option(level, I18n.t(`effort.${level}`), '', level === draft.reasoning)),
   ];
  }
  menu.replaceChildren(...rows, glide);
 }

 choose(kind, value) {
  const draft = this.draft;
  if (kind === 'provider') {
   if (value === draft.provider) return;
   const list = this.modelsOf(value);
   this.draft = { ...draft, provider: value, model: list[0]?.id || '', reasoning: this.draft.reasoning };
  } else if (kind === 'model') {
   this.draft = { ...draft, model: value };
  } else {
   this.draft = { ...draft, reasoning: value };
  }
  this.dirty = true;
  this.showChoice();
 }

 async apply() {
  const draft = this.draft;
  if (!draft) return;
  await this.settings.saveProfile({
   provider: draft.provider,
   model: draft.model,
   reasoning: draft.reasoning,
   temperature: typeof draft.temperature === 'number' ? draft.temperature : null,
   contextWindow: draft.contextWindow || 0,
  });
  this.draft = null;
  this.sync();
  this.say(I18n.t('settings.model.applied', { name: this.settings.profileName }));
 }

 // The name of a profile is written here: one made just now takes its first name, one already there takes another.
 openName(mode) {
  const profile = this.profile;
  if (!profile) return;
  if (mode === 'rename' && profile.id === 'default') return;
  this.naming = mode;
  this.nameForm.hidden = false;
  this.nameInput.value = mode === 'rename' ? this.settings.profiles.name(profile) : '';
  this.nameInput.focus();
  this.nameInput.select();
 }

 closeName() {
  this.naming = '';
  this.nameForm.hidden = true;
  this.nameInput.value = '';
 }

 async commitName() {
  const name = this.nameInput.value.trim();
  if (!name) return;
  if (this.naming === 'rename') {
   await this.settings.renameProfile(name);
   this.closeName();
  } else {
   const id = await this.settings.createProfile(name);
   if (id) {
    this.closeName();
    this.draft = null;
   }
  }
  this.sync();
 }

 async remove() {
  if (this.profile?.id === 'default') return;
  await this.settings.removeProfile();
  this.draft = null;
  this.sync();
 }

 // The two panes of the section: what a new chat is answered by, and the models that stand behind it.
 showPane(name) {
  for (const button of this.root.querySelectorAll('.model-subtab')) {
   const on = button.dataset.pane === name;
   button.classList.toggle('is-current', on);
   button.setAttribute('aria-selected', String(on));
  }
  for (const pane of this.root.querySelectorAll('.model-pane')) pane.hidden = pane.dataset.pane !== name;
 }

 // The profile's fallbacks as they stand, in its order. Every change here is written at once: an order is a choice,
 // and a list that only took effect on Apply would be a second place to remember to press.
 fallbacks() { return (this.profile?.fallbacks || []).map(item => ({ provider: item.provider || '', model: item.model })); }

 drawFallbacks() {
  const list = this.fallbacks();
  this.fallbackEmpty.hidden = list.length > 0;
  this.fallbackList.replaceChildren(...list.map((item, at) => {
   const model = this.settings.find(item.model);
   const row = document.createElement('li');
   row.className = 'model-fallback-row';
   row.dataset.at = String(at);
   row.draggable = true;
   row.tabIndex = 0;
   const grip = document.createElement('span');
   grip.className = 'model-fallback-grip';
   grip.setAttribute('aria-hidden', 'true');
   grip.innerHTML = GRIP;
   const name = document.createElement('span');
   name.className = 'lang-name';
   name.textContent = model?.name || item.model;
   const note = document.createElement('span');
   note.className = 'lang-note';
   note.textContent = window.Providers?.NAMES?.[item.provider || model?.provider || ''] || item.provider || '';
   const remove = document.createElement('button');
   remove.type = 'button';
   remove.className = 'model-fallback-remove';
   remove.dataset.at = String(at);
   remove.setAttribute('aria-label', I18n.t('settings.model.fallback.remove', { name: name.textContent }));
   remove.textContent = '×';
   row.append(grip, name, note, remove);
   return row;
  }));
 }

 // Adding asks the same list the picker does, with the models already standing behind this profile left out.
 openFallbackMenu() {
  const list = this.fallbacks(), taken = new Set(list.map(item => item.model));
  const rows = (this.settings.models || []).filter(model => !taken.has(model.id)).map(model => {
   const button = this.option(model.id, model.name || model.id, window.Providers?.NAMES?.[model.provider] || model.provider, false);
   return button;
  });
  this.fallbackMenu.replaceChildren(...rows);
  this.fallbackMenu.showPopover();
  const at = this.root.querySelector('.model-fallback-add').getBoundingClientRect();
  const box = this.root.closest('.settings-page')?.getBoundingClientRect() || { left: 0, right: innerWidth, top: 0, bottom: innerHeight };
  const left = Math.min(box.right - 10 - this.fallbackMenu.offsetWidth, Math.max(box.left + 10, at.right - this.fallbackMenu.offsetWidth));
  const top = Math.min(box.bottom - 10 - this.fallbackMenu.offsetHeight, at.bottom + 6);
  this.fallbackMenu.style.left = `${left}px`;
  this.fallbackMenu.style.top = `${top}px`;
  this.fallbackMenu.querySelector('.lang-option')?.focus({ preventScroll: true });
 }

 async addFallback(id) {
  const model = this.settings.find(id);
  if (!model) return;
  const list = this.fallbacks();
  if (list.some(item => item.model === id)) return;
  await this.commitFallbacks([...list, { provider: model.provider, model: id }]);
 }

 async removeFallback(at) {
  const list = this.fallbacks();
  if (!Number.isInteger(at) || at < 0 || at >= list.length) return;
  list.splice(at, 1);
  await this.commitFallbacks(list);
 }

 async moveFallback(from, by) {
  const list = this.fallbacks();
  const to = Math.min(list.length - 1, Math.max(0, from + by));
  if (from === to || !list[from]) return;
  const [moved] = list.splice(from, 1);
  list.splice(to, 0, moved);
  await this.commitFallbacks(list);
 }

 async commitFallbacks(list) {
  await this.settings.saveProfile({ fallbacks: list });
  this.sync();
 }

 // The heading of the choices names the profile they belong to, so a page left open on one profile does not quietly
 // take hold of another's.
 paintName(profile) {
  const label = this.root.querySelector('.model-choice-block .settings-label');
  if (label) label.textContent = `${I18n.t('settings.model.this')} · ${this.settings.profiles.name(profile)}`;
 }

 say(text) {
  this.status.textContent = text;
  clearTimeout(this.statusTimer);
  this.statusTimer = setTimeout(() => this.say(''), 4000);
 }
}

window.ModelSettings = ModelSettings;
})();
