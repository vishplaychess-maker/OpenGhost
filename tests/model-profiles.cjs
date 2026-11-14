'use strict';
// The profile file and the migration that makes the first one, with a store of the same shape the app's bridge has.
// No application profile, key, model or network is used.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const assert = require('node:assert/strict');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
let count = 0;
function check(name, value) { assert.ok(value, name); count++; console.log('ok  ' + name); }
const I18n = { t: (key, at) => at ? `${key}:${JSON.stringify(at)}` : key };

function harness(saved = null) {
 const files = new Map();
 if (saved) files.set('model-profiles', JSON.stringify(saved));
 const store = {
  read: async key => files.has(key) ? JSON.parse(files.get(key)) : null,
  write: async (key, value) => { files.set(key, JSON.stringify(value)); },
 };
 const c = { window: { openghost: { store } }, I18n, console };
 vm.createContext(c); vm.runInContext(read('model-profiles.js'), c);
 return { Profiles: c.window.ModelProfiles, files, make: () => new c.window.ModelProfiles(store) };
}

async function main() {
 // An install from before profiles: one remembered model, its effort and its fallback become the first profile.
 const fresh = harness();
 const legacy = { model: 'provider:model-a', reasoning: 'high', fallback: 'provider:model-b' };
 const profiles = fresh.make();
 await profiles.load(legacy);
 const first = profiles.active();
 check('A fresh install migrates its model into the default profile', first.id === 'default' && first.model === 'provider:model-a');
 check('Its effort becomes the profile’s reasoning level', first.reasoning === 'high');
 check('Its fallback becomes the first entry of the profile’s list', first.fallbacks.length === 1 && first.fallbacks[0].model === 'provider:model-b');
 check('The four profiles a fresh install starts with are there, the default first', profiles.list().map(p => p.id).join() === 'default,coding,writing,reasoning');
 check('Only the default carries the old choices', profiles.find('coding').model === '' && profiles.find('coding').fallbacks.length === 0);
 check('The file is written where the store keeps it', fresh.files.has('model-profiles'));
 check('The file is versioned and names the profile in use', JSON.parse(fresh.files.get('model-profiles')).version === 1 && profiles.activeId === 'default');

 // A second start reads the file and migrates nothing again.
 const again = fresh.make();
 await again.load({ model: 'provider:changed' });
 check('A file that exists is read as it stands, not migrated over', again.active().model === 'provider:model-a');

 // Switched, the file says so, and a start after it comes back on the other profile.
 await profiles.activate('coding');
 check('Switching a profile is written down', JSON.parse(fresh.files.get('model-profiles')).active === 'coding');
 const next = fresh.make();
 await next.load({});
 check('The next start opens on the profile that was in use', next.activeId === 'coding');

 // Apply: the profile in use takes the choices the page made.
 await next.update('coding', { provider: 'openai', model: 'gpt-x', reasoning: 'low' });
 check('Apply writes provider, model and reasoning into the profile', next.active().provider === 'openai' && next.active().model === 'gpt-x' && next.active().reasoning === 'low');
 check('A value the profile does not define is dropped rather than stored', await next.update('coding', { nonsense: true }) && !('nonsense' in next.active()));

 // Making, renaming and removing.
 const made = await next.create('Writing long');
 check('A new profile starts from the one in use and takes its name', made.name === 'Writing long' && made.model === 'gpt-x' && made.id === 'writing-long');
 check('Making a profile switches to it', next.activeId === made.id);
 check('A name that is only punctuation still becomes a usable id', (await next.create('!!!')).id === 'profile');
 const beforeRename = next.activeId;
 check('Renaming a profile changes only its name', await next.rename(made.id, 'Essays') && next.find(made.id).name === 'Essays' && next.activeId === beforeRename);
 check('The default profile cannot be renamed', !await next.rename('default', 'Nope') && next.find('default').name === '');
 check('The default profile cannot be removed', !await next.remove('default') && !!next.find('default'));
 await next.activate(made.id);
 check('Removing the profile in use puts the window back on the default', await next.remove(made.id) && next.activeId === 'default');

 // A file written by hand — or by a later version — is read into this shape rather than thrown away.
 const odd = harness({
  version: 1,
  active: 'gone',
  profiles: [
   { id: 'mine', name: 'Mine', model: 'm', temperature: 0.3, extra: 'dropped' },
   { id: 'mine', name: 'Duplicate' },
   { id: '', name: 'No id' },
  ],
 });
 const read2 = odd.make();
 await read2.load({});
 check('A file with no default gets one, first in the list', read2.list()[0].id === 'default');
 check('A profile whose id has gone cannot be the one in use', read2.activeId === 'default');
 check('Two profiles with one id become one', read2.list().filter(p => p.id === 'mine').length === 1);
 check('A profile with no id is dropped', read2.list().every(p => p.id));
 check('An unknown field is dropped, not carried along', !('extra' in read2.find('mine')));

 const cold = harness({ profiles: [{ id: 'default', temperature: 0 }, { id: 'hot', temperature: 7 }, { id: 'none', temperature: 'warm' }] });
 const coldRead = cold.make();
 await coldRead.load({});
 check('0 is a temperature a person may mean; outside 0…2 and non-numbers are not kept', coldRead.find('default').temperature === 0 && coldRead.find('hot').temperature === null && coldRead.find('none').temperature === null);

 const ctx = harness({ profiles: [{ id: 'default', contextWindow: 200000 }, { id: 'small', contextWindow: 12.7 }, { id: 'none', contextWindow: -5 }] });
 const ctxRead = ctx.make();
 await ctxRead.load({});
 check('A context override is a whole positive number, and 0 means the model’s own', ctxRead.find('default').contextWindow === 200000 && ctxRead.find('small').contextWindow === 13 && ctxRead.find('none').contextWindow === 0);

 // What a profile is called.
 const named = harness();
 const names = named.make();
 await names.load({});
 check('The four built-ins are named in the person’s language', names.name(names.find('default')) === 'model.profile.default');
 await names.create('Night');
 check('A profile made by hand is called by its name', names.list().some(p => p.name === 'Night' && names.name(p) === 'Night'));
 console.log(`\n${count} checks passed`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
