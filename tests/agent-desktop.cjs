'use strict';

// What the agent-desktop engine must never do: hand a shell to the model's words, act without a ticket, or say a
// result is safe to repeat when it may have landed. These are the rules the checks below hold it to.

const assert = require('node:assert/strict');
const path = require('node:path');
const Engine = require('../desktop/agent-desktop.js');

const checks = [];
const check = (name, fn) => { try { fn(); checks.push(`ok   ${name}`); } catch (error) { checks.push(`FAIL ${name}: ${error.message}`); } };

// --- the words handed to the program -------------------------------------------------------------------

check('a snapshot of an app passes its name as one argument, not through a shell', () => {
 const { args } = Engine.plan('desktop_snapshot', { app: 'Notes', interactive: true, compact: true });
 assert.deepEqual(args, ['snapshot', '--app', 'Notes', '-i', '--compact']);
});

check('an app name with spaces and quotes stays one argument', () => {
 const { args } = Engine.plan('desktop_find', { app: "My 'Odd' App", role: 'button', name: 'OK; rm -rf /" && calc' });
 assert.equal(args[2], "My 'Odd' App");
 assert.equal(args[4], 'button');
 assert.equal(args[6], 'OK; rm -rf /" && calc');
});

check('a ref is passed as it was given, and nothing else is allowed through', () => {
 assert.deepEqual(Engine.plan('desktop_click', { ref: '@s8f3k2p9:e12' }).args, ['click', '@s8f3k2p9:e12']);
 for (const bad of ['../../etc/passwd', '@s1:e1 --headed', '@s1:e1; rm -rf /', '', 's1:e1', '@:e1', '@s1:e', '@s1:e1x']) {
  const { error } = Engine.plan('desktop_click', { ref: bad });
  assert.ok(error, `refused nothing for ${JSON.stringify(bad)}`);
 }
});

check('the headed flag is never taken from what the model writes', () => {
 for (const name of ['desktop_snapshot', 'desktop_click', 'desktop_type']) {
  const { args = [] } = Engine.plan(name, name === 'desktop_type'
   ? { ref: '@s1:e1', text: 'x', headed: true } : { app: 'Notes', headed: true, '--headed': true });
  assert.ok(!args.includes('--headed'), `${name} let --headed through`);
 }
});

check('drag is physical by its nature: the engine says so, and raw coordinates are refused', () => {
 assert.deepEqual(Engine.plan('desktop_drag', { from: '@s1:e1', to: '@s1:e2' }).args,
  ['drag', '--from', '@s1:e1', '--to', '@s1:e2', '--headed']);
 assert.ok(Engine.plan('desktop_drag', { from: '@s1:e1', to: '120,340' }).error);
});

check('numbers are bounded rather than trusted', () => {
 assert.ok(Engine.plan('desktop_scroll', { ref: '@s1:e1', direction: 'down', amount: 3 }).args.includes('3'));
 assert.ok(Engine.plan('desktop_scroll', { ref: '@s1:e1', amount: 900 }).error);
 assert.ok(Engine.plan('desktop_scroll', { ref: '@s1:e1', direction: 'sideways' }).error);
 assert.ok(Engine.plan('desktop_snapshot', { app: 'Notes', maxDepth: 99 }).error);
 assert.ok(Engine.plan('desktop_type', { ref: '@s1:e1', text: 'x'.repeat(20000) }).error);
});

check('a key combo is checked before it is sent', () => {
 assert.deepEqual(Engine.plan('desktop_press', { combo: 'ctrl+s' }).args, ['press', 'ctrl+s']);
 assert.ok(Engine.plan('desktop_press', { combo: 'ctrl+' }).error);
 // The program refuses dangerous shortcuts unless --force says otherwise; the engine never says.
 assert.ok(!Engine.plan('desktop_press', { combo: 'alt+f4', app: 'Notes' }).args.includes('--force'));
});

check('closing an app gently and terminating it are different things', () => {
 assert.deepEqual(Engine.plan('desktop_close', { app: 'Notes' }).args, ['close-app', 'Notes']);
 assert.deepEqual(Engine.plan('desktop_close', { app: 'Notes', force: true }).args, ['close-app', 'Notes', '--force']);
});

check('an unknown tool is said as unknown', () => {
 assert.ok(Engine.plan('desktop_teleport', {}).error);
});

check('an element is read with the property asked for, and a state with the states word', () => {
 assert.deepEqual(Engine.plan('desktop_read', { ref: '@s1:e1' }).args, ['get', '@s1:e1']);
 assert.deepEqual(Engine.plan('desktop_read', { ref: '@s1:e1', property: 'bounds' }).args, ['get', '@s1:e1', '--property', 'bounds']);
 assert.deepEqual(Engine.plan('desktop_read', { ref: '@s1:e1', kind: 'state', property: 'checked' }).args, ['is', '@s1:e1', '--property', 'checked']);
 assert.ok(Engine.plan('desktop_read', { ref: '@s1:e1', kind: 'state', property: 'text' }).error);
});

check('the window words map to the commands the program really has', () => {
 assert.deepEqual(Engine.plan('desktop_window', { action: 'focus', app: 'Notes' }).args, ['focus-window', '--app', 'Notes']);
 assert.deepEqual(Engine.plan('desktop_window', { action: 'minimize', app: 'Notes' }).args, ['minimize', '--app', 'Notes']);
 assert.deepEqual(Engine.plan('desktop_window', { action: 'resize', windowId: '4213', width: 1200, height: 800 }).args,
  ['resize-window', '--window-id', '4213', '--width', '1200', '--height', '800']);
 assert.ok(Engine.plan('desktop_window', { action: 'resize', app: 'Notes', width: 1200 }).error);
 assert.ok(Engine.plan('desktop_window', { action: 'shake', app: 'Notes' }).error);
});

// --- the gate ------------------------------------------------------------------------------------------

check('only what changes the computer needs a ticket', () => {
 for (const name of ['desktop_click', 'desktop_type', 'desktop_press', 'desktop_drag', 'desktop_window', 'desktop_launch', 'desktop_close']) {
  assert.ok(Engine.needsTicket(name), `${name} went ungated`);
 }
 for (const name of ['desktop_status', 'desktop_apps', 'desktop_windows', 'desktop_snapshot', 'desktop_find', 'desktop_read', 'desktop_scroll']) {
  assert.ok(!Engine.needsTicket(name), `${name} was gated`);
 }
});

check('a ticket is one-use, bound to its action, its window and its moment', () => {
 const name = 'desktop_click', args = { ref: '@s1:e1' };
 assert.ok(Engine.consume(name, args, '', 'win-1').includes('not approved'));
 const ticket = Engine.authorize(name, args, 'win-1').ticket;
 assert.equal(Engine.consume(name, args, ticket, 'win-1'), '');
 assert.ok(Engine.consume(name, args, ticket, 'win-1').includes('not approved'), 'the ticket worked twice');
 // A wrong word or a wrong window spends the ticket: it is gone before it is judged, so a guesser gets one try.
 const other = Engine.authorize(name, args, 'win-1').ticket;
 assert.ok(Engine.consume(name, { ref: '@s1:e2' }, other, 'win-1').includes('changed after it was approved'));
 const elsewhere = Engine.authorize(name, args, 'win-1').ticket;
 assert.ok(Engine.consume(name, args, elsewhere, 'win-2').includes('another window'));
});

check('a ticket for one tool does not open another', () => {
 const ticket = Engine.authorize('desktop_type', { ref: '@s1:e1', text: 'hi' }, 'win-1').ticket;
 const refused = Engine.consume('desktop_press', { combo: 'return' }, ticket, 'win-1');
 assert.ok(refused && refused.includes('changed after it was approved'), refused || 'it was accepted');
});

// --- what comes back -----------------------------------------------------------------------------------

check('the envelope decides whether a repeat is safe', () => {
 assert.equal(Engine.retryable({ ok: false, error: { code: 'TIMEOUT', disposition: { delivery: 'not_delivered', retry: 'safe' } } }), true);
 assert.equal(Engine.retryable({ ok: false, error: { code: 'STALE_REF', disposition: { delivery: 'delivered', retry: 'unsafe' } } }), false);
 assert.equal(Engine.retryable({ ok: false, error: { code: 'POLICY_DENIED' } }), false);
});

check('an error is said with its code, never as a bare message', () => {
 const said = Engine.explain({ ok: false, error: { code: 'AMBIGUOUS_TARGET', message: 'identity_not_unique', suggestion: 'act on a unique control' } });
 assert.match(said, /AMBIGUOUS_TARGET/);
 assert.match(said, /identity_not_unique/);
 assert.match(said, /unique control/);
});

check('a tree that will not fit is cut with a word about what was cut', () => {
 const big = JSON.stringify({ version: '2.6', ok: true, command: 'snapshot', data: { tree: { deep: 'x'.repeat(Engine.LIMIT) } } });
 const cut = Engine.shown(big);
 assert.ok(cut.length <= Engine.LIMIT + 200, `kept ${cut.length} characters`);
 assert.match(cut, /omitted|cut|truncated/i);
});

// --- where it lives ------------------------------------------------------------------------------------

check('the logs go to the place asked for and nowhere on another drive', () => {
 assert.equal(Engine.logDir({ packaged: false, repo: 'D:/experiment/OpenGhost', userData: 'C:/Users/x/AppData' }),
  path.join('D:/experiment/OpenGhost', 'agent-logs'));
 assert.equal(Engine.logDir({ packaged: true, repo: 'D:/nowhere', userData: 'D:/experiment/.openghost-data' }),
  path.join('D:/experiment/.openghost-data', 'agent-logs'));
});

check('a missing program is said as one line that says what to do', () => {
 assert.match(Engine.MISSING, /npm install -g agent-desktop/);
});

const failed = checks.filter(line => line.startsWith('FAIL'));
console.log(checks.join('\n'));
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
