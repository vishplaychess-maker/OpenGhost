(() => {
'use strict';

// Settings → Model: what a chat is answered by, and how, gathered into profiles. A profile is a preset the window
// carries — its model answers new chats and drafts, its reasoning level is how they think, its fallbacks stand behind
// it — while every chat keeps whatever model and effort it was given, so changing profiles never rewrites a chat that
// already exists. The file is written through the same store the chats are, so it follows the person's data folder and
// does not live inside the app.
const KEY = 'model-profiles';
const VERSION = 1;
// The four a fresh install starts with. `default` is always there and cannot be renamed or removed: it is where an
// install lands, and what a deleted profile falls back to.
const BUILTINS = ['default', 'coding', 'writing', 'reasoning'];

// What a profile holds. An absent choice means "as the model has it": no temperature of its own, the model's own window,
// and the reasoning level the model calls its default.
const blank = () => ({ provider: '', model: '', fallbacks: [], reasoning: '', temperature: null, contextWindow: 0 });

// A name written by hand becomes an id that can be read: the ids of the four built-ins are never handed out again.
function slug(name, taken) {
 const base = String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'profile';
 let id = base;
 for (let n = 2; taken.has(id) || BUILTINS.includes(id); n++) id = `${base}-${n}`;
 return id;
}

class ModelProfiles {
 constructor(store = window.openghost?.store) {
  this.store = store;
  this.data = null;
 }

 get profiles() { return this.data?.profiles || []; }
 get activeId() { return this.data?.active || 'default'; }
 list() { return this.profiles.slice(); }
 find(id) { return this.profiles.find(profile => profile.id === id) || null; }
 active() { return this.find(this.activeId) || this.profiles[0] || null; }

 // Read once at start. A missing file is an install from before profiles existed: the single model it kept, its effort
 // and its fallback become the first profile, and the old keys are left exactly as they were.
 async load(seed = {}) {
  const saved = await this.read();
  this.data = saved ? this.normalize(saved) : this.migrate(seed);
  if (!saved) await this.save();
  return this.data;
 }

 async read() {
  try {
   const value = await this.store?.read(KEY);
   return value && typeof value === 'object' && Array.isArray(value.profiles) ? value : null;
  } catch { return null; }
 }

 migrate({ model = '', reasoning = '', fallback = '' } = {}) {
  const profiles = BUILTINS.map((id, at) => ({
   ...blank(),
   id,
   name: '',
   // Only the first profile is given what the install had: the others start empty and are filled by hand.
   ...(at === 0 ? { model, reasoning, fallbacks: fallback ? [{ provider: '', model: fallback }] : [] } : {}),
  }));
  return { version: VERSION, active: 'default', profiles };
 }

 // A file written by hand, or by a version that knew more fields, is read into the shape this one expects rather than
 // thrown away: an unknown field is dropped, a missing one gets its default, and the first profile is always `default`.
 normalize(data) {
  const seen = new Set();
  const profiles = (Array.isArray(data.profiles) ? data.profiles : []).map(profile => this.clean(profile)).filter(profile => {
   if (!profile.id || seen.has(profile.id)) return false;
   seen.add(profile.id);
   return true;
  });
  if (!profiles.some(profile => profile.id === 'default')) profiles.unshift({ ...blank(), id: 'default', name: '' });
  // `default` leads the list: it is the one that cannot be removed, and the one a person looks for first.
  profiles.sort((a, b) => (a.id === 'default' ? -1 : b.id === 'default' ? 1 : 0));
  const active = profiles.some(profile => profile.id === data.active) ? data.active : 'default';
  return { version: VERSION, active, profiles };
 }

 clean(profile) {
  const value = { ...blank(), ...(profile && typeof profile === 'object' ? profile : {}) };
  const fallbacks = (Array.isArray(value.fallbacks) ? value.fallbacks : [])
   .filter(item => item && typeof item === 'object' && typeof item.model === 'string' && item.model)
   .map(item => ({ provider: typeof item.provider === 'string' ? item.provider : '', model: item.model }));
  const temperature = Number(value.temperature);
  const context = Number(value.contextWindow);
  return {
   id: typeof value.id === 'string' ? value.id : '',
   name: typeof value.name === 'string' ? value.name : '',
   provider: typeof value.provider === 'string' ? value.provider : '',
   model: typeof value.model === 'string' ? value.model : '',
   fallbacks,
   reasoning: typeof value.reasoning === 'string' ? value.reasoning : '',
   // Unset is null, not 0: 0 °C is a temperature a person may well mean.
   temperature: typeof value.temperature === 'number' && temperature >= 0 && temperature <= 2 ? temperature : null,
   contextWindow: Number.isFinite(context) && context > 0 ? Math.round(context) : 0,
 };
 }

 async save() {
  try { await this.store?.write(KEY, this.data); } catch { /* a profile that will not write is still in memory */ }
 }

 async activate(id) {
  if (!this.find(id)) return false;
  if (this.data.active !== id) {
   this.data.active = id;
   await this.save();
  }
  return true;
 }

 async update(id, patch) {
  const profile = this.find(id);
  if (!profile) return null;
  Object.assign(profile, this.clean({ ...profile, ...patch, id }));
  await this.save();
  return profile;
 }

 // A new profile starts from the one in use, because a person making "Writing" usually means "like this, but…".
 async create(name, from = this.active()) {
  const id = slug(name, new Set(this.profiles.map(profile => profile.id)));
  const copy = this.clean({ ...(from || blank()), id, name: String(name || '').trim() });
  this.data.profiles.push(copy);
  this.data.active = id;
  await this.save();
  return copy;
 }

 async rename(id, name) {
  const profile = this.find(id);
  const value = String(name || '').trim();
  if (!profile || id === 'default' || !value) return false;
  profile.name = value;
  await this.save();
  return true;
 }

 async remove(id) {
  if (id === 'default' || !this.find(id)) return false;
  this.data.profiles = this.profiles.filter(profile => profile.id !== id);
  if (this.data.active === id) this.data.active = 'default';
  await this.save();
  return true;
 }

 // What a profile is called: the four built-ins are named in the person's language, the others by the name they were
 // given, and a profile whose name was never written says why it is called that.
 name(profile) {
  if (!profile) return '';
  if (profile.name) return profile.name;
  if (BUILTINS.includes(profile.id)) return I18n.t(`model.profile.${profile.id}`);
  return profile.id;
 }
}

window.ModelProfiles = ModelProfiles;
})();
