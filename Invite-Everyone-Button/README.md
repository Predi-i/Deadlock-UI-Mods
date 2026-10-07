# Invite Everyone Button

Adds **Invite** above the native Settings row in Deadlock's Esc menu. Clicking
opens the existing playtest invitation popup and activates eligible friend cards
in its **Can Invite** category. These are Deadlock playtest invitations, not party
invitations. Already invited/owned categories are never processed.

Only `panorama/layout/friends_list.xml` is overridden. The mod uses the sidebar
shown in the Panorama Debugger capture; it does not override `hud_escape_menu.xml`,
`hud.xml`, `base_hud.xml`, friend-card layouts or popup layouts. The original
Recommend button still works manually. Another mod replacing `friends_list.xml`
must retain this mod's script include to combine them.

One controller belongs to the current escape menu and its live sidebar script
context. The include starts its own deferred initialization; it does not depend
on the native C++ root delivering `onload`. If the sidebar is initially invalid,
detached or its menu anchor is not ready, one bounded retry chain waits for it.
The chain ends on successful insertion, owner destruction, or a five-second
timeout with a specific diagnostic. HUD/WindowRoot inherited script contexts use
the verified direct HUD/Esc route. Repeated evaluation reuses this bootstrap,
the controller and the button. Replacing the owner disposes pending work and
rebinds the button; dashboard lists do nothing. There is no recurring injection
loop, idle timer or global event listener after initialization.
If another mod deletes only the injected button, the next sidebar initialization
can restore it; no background watchdog runs to detect that change.

The sidebar and eligible category use direct-child breadcrumbs verified against
native XML. The only recursive lookup is `FriendMenu` inside the small native
`PopupPlaytestUser` subtree. Its handle is cached for the operation. The eligible
list is snapshotted once; each wrapper's immediate native `CitadelFriend` is
checked immediately before activation. There are no walks through card bodies
or unrelated HUD descendants. Eight entries are processed per callback, followed
by one short continuation. A delay requests a yield; the engine determines actual
delivery/frame timing. It is not a server rate-limit or latency guarantee.

Popup/list discovery is bounded to five seconds. A run stops when the escape
menu, popup, sidebar or list is destroyed, hidden or replaced. Each loaded entry
is attempted at most once per run, even without native acknowledgement. An empty
or unavailable list restores the button after the discovery timeout. If Steam
populates additional entries after the snapshot, click Invite again after loading.
The popup stays open for inspection. Logs count native activation requests;
they do not claim the server accepted or delivered invitations.

## Offline verification

The development-only harness uses the QOLLOCK simulator, operation counters and
raw schedule probe. It does not load the QOLLOCK mod or modify that checkout:

```text
node Invite-Everyone-Button/tools/check_invites.cjs --qollock <QOLLOCK checkout>
```

The seventeen focused scenarios cover include-only startup without `onload`,
initially invalid/detached contexts, delayed anchors, bounded startup failure,
inherited HUD/WindowRoot contexts, duplicate initialization, invalid/disabled
cards, delayed/empty popups, unacknowledged activations, closure during a batch,
panel replacement, native failures and idle work. On the fixture with 1,000
friends and 5,000 unrelated HUD panels, the run performs one popup-scoped
recursive lookup, 126 callbacks with one pending continuation at most, and no
scheduled work afterwards. Direct lookups visit 143 modeled nodes in total;
separate `Children()` enumeration counts 2,005 references. These are distinct
operation counts, not native CPU timings or FPS. Fixture counts exclude native
engine reactions and do not prove dynamic panels are instantiated identically.

## Maintainer client checks

After compiling/repacking, check **Invite** styling/placement with QOLLOCK and
Minigames, repeated Esc openings, hideout/match transitions and sidebar recreation.
The debugger console should report `[InviteEveryone] Ready` with the Esc button
route. A startup timeout names the missing stage. If no `[InviteEveryone]` message
appears, check that the mod's `friends_list.xml` and script are actually loaded,
including override order relative to other VPKs. Logs alone do not prove styling.
Click Invite with a small eligible list first: confirm native cards actually move
to the pending/invited category and no extra confirmation popup interrupts it.
Compare native counts before/after, including offline friends and lists requiring
scrolling. Check a large list, close the popup/Esc mid-run and reopen, and confirm
already invited friends are skipped. Capture frame times separately during idle
and sending; the offline model cannot validate rendering, server acceptance,
server throttling, lazy card creation or real FPS.

Only `panorama/` contains game assets. `tools/` and this README are development
files. Compilation, VPK packaging and installation are performed by the maintainer.
