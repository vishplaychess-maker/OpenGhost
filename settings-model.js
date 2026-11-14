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
// The same three fields on every list, so one watch covers them all.
const watched = new WeakSet();

class ModelSettings {
 constructor({ root, settings }) {
  this.root = root;
  this.settings = settings;
  this.draft = null;
  this.panes = new Map();
  this.root.innerHTML = `
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
    <p class="settings-status model-status" role="status"></p>
    <div class="lang-menu model-provider-menu" popover role="listbox" aria-label="${I18n.t('settings.model.provider')}"></div>
    <div class="lang-menu model-model-menu" popover role="listbox" aria-label="${I18n.t('settings.model.model')}"></div>
    <div class="lang-menu model-reasoning-menu" popover role="listbox" aria-label="${I18n.t('settings.model.reasoning')}"></div>
   </section>`;
  this.list = this.root.querySelector('.model-profile-list');
  this.status = this.root.querySelector('.model-status');
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
  return { provider, model: chosen?.id || profile?.model || '', reasoning: profile?.reasoning || '' };
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
  await this.settings.saveProfile({ provider: draft.provider, model: draft.model, reasoning: draft.reasoning });
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
