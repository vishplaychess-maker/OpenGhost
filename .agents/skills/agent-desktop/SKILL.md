---
name: agent-desktop
description: >
  Use to see and work another desktop program through the operating system's accessibility tree instead of the
  screen: press its buttons, fill its fields, read what a window holds, work its menus, move or resize its windows,
  start or quit an app. In OpenGhost these are the desktop_* tools, and every action that changes a program is shown
  to the user on a card before it happens. Triggers on: click a button in an app, fill a form, read a window,
  navigate a menu, toggle a checkbox, type into a field, work a desktop app, computer use, accessibility tree.
compatibility: Needs the agent-desktop program on the computer (npm install -g agent-desktop) and the
  "Accessibility computer use" switch on in Settings → General. On macOS the system must also be told to allow it in
  System Settings → Privacy & Security → Accessibility.
license: Apache-2.0 (the tool it drives is Vercel Labs' agent-desktop)
---

# Working another program by its accessibility tree

The `desktop_*` tools read a program the way an assistive technology reads it: a tree of buttons, fields, rows and
menus, each with a name, a role, a state and an **address** like `@s8f3k2p9:e12`. You act on an address. You do not
look at pixels, and you do not guess coordinates.

Use these tools when the task is about a program on this computer. Use the browser tools when it is about a web page
in the built-in browser, and `read_file` when it is about a file. Reach for `take_screenshot` (the mouse-and-keyboard
family) only when a program hides its controls from the tree — some do — and say so in your words.

## The loop

Read, act, read the same place again. Nothing else tells you whether your action landed.

```
desktop_snapshot   { app: "Notes", interactive: true, compact: true }   # what is in the window
desktop_find       { app: "Notes", role: "button", name: "Save" }       # or go straight to one control
desktop_click      { ref: "@s8f3k2p9:e12" }                             # the user is asked first
desktop_snapshot   { app: "Notes", root: "@s8f3k2p9:e3" }               # verify: read that part again
```

- `desktop_find` when you already know the name or the kind of the control. It is cheap and it answers with addresses.
- `desktop_snapshot` with `skeleton: true` for a big window: a shallow map that says how many children each cut
  branch holds. Then go deeper with `root` set to one of those addresses, instead of reading the whole window twice.
- `interactive: true` keeps only what a person can act on. Leave it out when you need a row's label to tell which
  row a repeated button belongs to.
- Never skeleton a `menu`, `sheet` or `alert` surface — pass `surface` and read it whole; it is already focused.
- An action that opens a menu, sheet or alert names the surfaces it opened. Read that new surface next, not the
  window behind it.

## Addresses, and why they die

An address belongs to the reading it came from. After anything changed the window — your own action included — read
that part again and use the new address.

- `STALE_REF`: the element is gone or no longer matches. Read again. Do not retry the old address.
- `AMBIGUOUS_TARGET` (`identity_not_unique`): on Windows and Linux an address exists only when one element in that
  window matched its role, name and description. A button repeated in every row of a list has no address at all.
  Act on a control that is unique, or read the single row with `root` and look again; if it still cannot be told
  apart, say what you found rather than firing blind.
- A `TIMEOUT` whose details say identity is unproven sent nothing. Retry that one.

**Never fall back to pixel coordinates.** The tools refuse them on purpose: `--xy`, `headed` and `force` are not
arguments you may pass, and a coordinate you read off a scaled screenshot will land somewhere else anyway. When the
tree cannot reach something, the honest answer is that this program is beyond these tools.

## Retrying without doing it twice

An action's answer carries how it went. Repeat an action **only** when the answer says nothing was delivered —
`it is safe to try again`. Anything else may have landed: a second `desktop_click` presses twice, a second
`desktop_type` writes the words twice, and `toggle` undoes itself. When an answer is not safe to repeat, read the
live state with `desktop_read` (kind `state`, or the `value`/`text` property) and decide from what you see.

Branch on the code, not on the sentence: codes and wording change between versions, `STALE_REF` and
`AMBIGUOUS_TARGET` do not.

## Reading costs, so read once

Each call runs a separate program and pays for starting it. Do not re-read a whole window to check one thing:
read the region you are working in, ask for one property with `desktop_read`, and keep the addresses you have until
something changes. Two or three careful reads of one part of a window beat one giant read of all of it, and a read
of everything after every click is the slowest way there is.

## Keys, and what they really hit

`desktop_press` sends a shortcut to a program. A key goes to whatever has the focus, which is often not the window
you meant — so prefer pressing the actual button by its address. Give `app` (or `windowId` when several windows share
one name) so the keys land in the right process. Shortcuts the program itself calls dangerous are refused, and this
skill does not insist on them.

`desktop_drag` and `desktop_click` with `action: "double"` are physical: they take the window and move the real
pointer. Use them only where no semantic action exists — a sortable list, a canvas, a resize handle — and expect the
user to see the cursor move.

## What the user sees, and what you must not do for them

Every action that changes another program is shown on a card first, in every permission mode, with the control, the
window or the exact text involved. So:

- Put the reason in `description`. It is what the user reads before deciding.
- Do not type secrets, tokens or passwords into a field unless the person asked for exactly that. The card shows
  the words.
- Do not quit or terminate another program on your own judgement. `desktop_close` with `force: true` loses whatever
  that app had not saved; use it only when the user asked for it.
- Say what you are about to do in one line before a card appears for it, and check the result after.

## When a tool says the program is not there

`agent-desktop is not on this computer. Install it with: npm install -g agent-desktop` means exactly that: the tools
are offered but the program is not installed. Tell the user, in your own words, and stop — installing it is their
decision, not a step you take. On macOS, a refusal that mentions permissions means the Accessibility grant has not
been given; the user does that in System Settings, and `desktop_status` reports which state the machine is in.

## Deeper detail, for the exact version installed

The program carries its own reference, matched to the version on this computer. Read it through the shell tool when
you need more than this skill holds:

```
agent-desktop skills get desktop      # the loop, addresses, retries, delivery
agent-desktop skills get platform     # what differs on this operating system
agent-desktop <command> --help        # the flags of one command
```
