(() => {
'use strict';

// The profile in use, in the composer beside the model it names. Choosing another swaps what this window is answered
// by at once — the model a new chat starts on — while the chat on screen keeps the model it was given, which the
// button beside this one still shows. The menu is the settings' own listbox, made small: one highlight, rows with the
// model under each name, and a way through to the page that makes and edits profiles.

const EDGE = 10;
const watched = new WeakSet();

class ProfileButton {
 constructor({ button, host = document.body, settings, chat, onOpen }) {
  this.button = button;
  this.host = host;
  this.settings = settings;
  this.chat = chat;
  this.onOpen = onOpen;
  this.name = button.querySelector('.profile-name') || button;
  this.menu = this.build();
  button.setAttribute('aria-haspopup', 'listbox');
  button.setAttribute('aria-expanded', 'false');
  button.addEventListener('click', () => this.toggle());
  // A profile switched anywhere (the page, another window) is read again here.
  const prior = this.settings.onModels;
  this.settings.onModels = () => { prior?.(); this.sync(); };
  this.sync();
 }

 build() {
  const menu = document.createElement('div');
  menu.className = 'lang-menu composer-profile-menu';
  menu.setAttribute('popover', '');
  menu.setAttribute('role', 'listbox');
  document.body.append(menu);
  const glide = menu.appendChild(document.createElement('span'));
  glide.className = 'lang-glide';
  glide.setAttribute('aria-hidden', 'true');
  this.glide = glide;
  if (watched.has(menu)) return menu;
  watched.add(menu);
  menu.addEventListener('toggle', event => this.button.setAttribute('aria-expanded', String(event.newState === 'open')));
  menu.addEventListener('pointerover', event => this.point(event.target.closest('.lang-option')));
  menu.addEventListener('pointerleave', () => { this.glide.style.opacity = '0'; });
  menu.addEventListener('focusin', event => this.point(event.target.closest('.lang-option')));
  menu.addEventListener('click', event => {
   const option = event.target.closest('.lang-option');
   if (!option) return;
   menu.hidePopover();
   if (option.dataset.profile === '!manage') return this.onOpen?.();
   const id = option.dataset.profile;
   if (id && id !== this.settings.profile) this.settings.setProfile(id).then(() => this.sync());
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
  return menu;
 }

 get profiles() { return this.settings.profiles?.list() || []; }

 // The chip is only there when there is a choice to make: one profile makes no decision, and the model chip already
 // says what this window is answered by.
 sync() {
  const name = this.settings.profileName || '';
  this.button.hidden = this.profiles.length < 2;
  this.button.setAttribute('aria-label', I18n.t('model.profile.current', { name }));
  this.button.title = I18n.t('model.profile.current', { name });
  if (this.name !== this.button) this.name.textContent = name;
  if (this.menu.matches(':popover-open') && this.profiles.length < 2) this.menu.hidePopover();
 }

 toggle() {
  if (this.menu.matches(':popover-open')) return this.menu.hidePopover();
  this.fill();
  this.menu.showPopover();
  // The menu paints at its default place for a frame unless it is told where to stand before the frame is drawn.
  this.place();
  const chosen = this.menu.querySelector('.lang-option[aria-selected="true"]');
  this.point(chosen);
  chosen?.focus({ preventScroll: true });
  chosen?.scrollIntoView({ block: 'nearest' });
 }

 fill() {
  const rows = this.profiles.map(profile => {
   const button = document.createElement('button');
   button.type = 'button';
   button.className = 'lang-option';
   button.setAttribute('role', 'option');
   button.tabIndex = -1;
   button.dataset.profile = profile.id;
   button.setAttribute('aria-selected', String(profile.id === this.settings.profile));
   const title = document.createElement('span');
   title.className = 'lang-name';
   title.textContent = this.settings.profiles.name(profile);
   const note = document.createElement('span');
   note.className = 'lang-note';
   const model = profile.model ? this.settings.find(profile.model) : null;
   note.textContent = model?.name || profile.model || '';
   button.append(title, note);
   return button;
  });
  const manage = document.createElement('button');
  manage.type = 'button';
  manage.className = 'lang-option is-manage';
  manage.setAttribute('role', 'option');
  manage.tabIndex = -1;
  manage.dataset.profile = '!manage';
  manage.setAttribute('aria-selected', 'false');
  const label = document.createElement('span');
  label.className = 'lang-name';
  label.textContent = I18n.t('model.profile.manage');
  manage.append(label);
  this.menu.replaceChildren(...rows, manage, this.glide);
 }

 point(option) {
  if (!option) return;
  this.glide.style.opacity = '1';
  this.glide.style.height = `${option.offsetHeight}px`;
  this.glide.style.transform = `translateY(${option.offsetTop}px)`;
 }

 // Under the chip, as wide as its rows, kept inside the window.
 place() {
  const at = this.button.getBoundingClientRect(), box = { width: innerWidth, height: innerHeight };
  const left = Math.min(box.width - EDGE - this.menu.offsetWidth, Math.max(EDGE, at.left));
  const top = Math.min(box.height - EDGE - this.menu.offsetHeight, at.top - this.menu.offsetHeight - 8);
  this.menu.style.left = `${left}px`;
  this.menu.style.top = `${Math.max(EDGE, top)}px`;
 }
}

window.ProfileButton = ProfileButton;
})();
