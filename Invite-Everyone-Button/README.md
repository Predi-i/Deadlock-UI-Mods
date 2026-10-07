# Invite Everyone Button

Adds **Invite** above the native Settings row in Deadlock's Esc menu. Clicking
opens the existing playtest invitation popup and activates eligible friend cards
in its **Can Invite** category. These are Deadlock playtest invitations, not party
invitations. Already invited/owned categories are never processed.

Only `panorama/layout/citadel_hud_combat_log.xml` is overridden to load the script.
Both the native HUD and QOLLOCK declare this persistent panel under `Hud`; its
presence is confirmed in the maintainer's debugger capture. The native combat-log
markup and behavior are unchanged. Current QOLLOCK and Minigames have no override
of this resource. The mod does not ship `friends_list.xml`, `hud_escape_menu.xml`,
`hud.xml`, `base_hud.xml`, friend-card layouts or popup layouts. This avoids the
previous conflict with QOLLOCK's friend-search override. The existing sidebar
Recommend button still opens the native invitation popup manually.

One controller belongs to the current escape menu and its live HUD host script
context. The include starts its own deferred initialization; it does not depend
on the native C++ root delivering `onload`. If the host is initially invalid,
detached or its menu anchor is not ready, one bounded retry chain waits for it.
The chain ends on successful insertion, owner destruction, or a five-second
timeout with a specific diagnostic. HUD/WindowRoot inherited script contexts use
the verified direct HUD/Esc route. Repeated evaluation reuses this bootstrap,
the controller and the button. Replacing the owner disposes pending work and
rebinds the button. There is no recurring injection
loop, idle timer or global event listener after initialization.
If another mod deletes only the injected button, the next host initialization
can restore it; no background watchdog runs to detect that change.

The sidebar and eligible category use direct-child breadcrumbs verified against
native XML. The only recursive lookup is `FriendMenu` inside the small native
`PopupPlaytestUser` subtree. Its handle is cached for the operation. The eligible
list is snapshotted once; each wrapper's immediate native `CitadelFriend` is
checked immediately before activation. There are no walks through card bodies
or unrelated HUD descendants. Eight entries are processed per callback with at
most eight requests awaiting a native result. Immediate results allow fast
batches; delayed replies overlap within this bound. There is only one scheduled
continuation, not one timer per friend. A delay requests a yield; the engine
determines actual delivery/frame timing. These limits are not a server rate-limit
or latency guarantee.

Result dialogs are recognized using native localized playtest result title/body
tokens and the captured `PopupGeneric#ConfirmUseTool` structure. Only new dialogs
from the active run with the single `ButtonContainer/Button0.PopupButton.isAutoConfirm`
are acknowledged through native `Activated(..., "mouse")`. Existing dialogs,
unknown messages and multi-button confirmations are preserved. Native processing
messages may coexist with bounded parallel requests. Each result OK is clicked
once; delayed native dismissal is awaited. A missing result, unknown dialog or
failed dismissal stops further sending after a bounded response timeout. Native
rejections are counted separately from activation requests; closing OK does not
turn a rejected limited Steam user into a successful invite.

Popup/list discovery is bounded to five seconds. A run stops when the escape
menu, popup, host or list is destroyed, hidden or replaced. Each loaded entry
is attempted at most once per run, even without native acknowledgement. An empty
or unavailable list restores the button after the discovery timeout. If Steam
populates additional entries after the snapshot, click Invite again after loading.
The invitation list stays open for inspection; recognized result dialogs are
closed automatically. Requests already handed to the engine cannot be recalled.
If a run is cancelled or times out, up to eight late replies can still arrive;
there is no permanent observer to dismiss replies outside the active run. Logs
count activation requests, native result dialogs and rejections, not deliveries.

## Offline verification

The development-only harness uses the QOLLOCK simulator, operation counters and
raw schedule probe. It does not load the QOLLOCK mod or modify that checkout:

```text
node Invite-Everyone-Button/tools/check_invites.cjs --qollock <QOLLOCK checkout>
```

The twenty-seven focused scenarios cover include-only startup without `onload`,
initially invalid/detached contexts, delayed anchors, bounded startup failure,
inherited HUD/WindowRoot contexts, duplicate initialization, invalid/disabled
cards, delayed/empty popups, unacknowledged activations, closure during a batch,
panel replacement, native failures, localized result dialogs, delayed parallel
responses, one-time native OK activation, unrelated dialog preservation,
override collisions and idle work. On the fixture with 1,000
friends and 5,000 unrelated HUD panels, the run performs one popup-scoped
recursive lookup, 126 callbacks with one pending continuation at most, and no
scheduled work afterwards. The modeled 1,000 immediate result dialogs are all
acknowledged. Direct/scoped lookups visit 10,644 modeled nodes in total;
separate `Children()` enumeration counts 7,131 references. These are distinct
operation counts, not native CPU timings or FPS. Fixture counts exclude native
engine reactions and do not prove dynamic panels are instantiated identically.

## Maintainer client checks

After compiling/repacking, check **Invite** styling/placement with QOLLOCK and
Minigames in both VPK priority orders, repeated Esc openings, hideout/match
transitions and HUD host recreation. Confirm QOLLOCK's friend search remains intact.
The debugger console should report `[InviteEveryone] Ready` with the Esc button
route. A startup timeout names the missing stage. If no `[InviteEveryone]` message
appears, check that the mod's `citadel_hud_combat_log.xml` and script are actually loaded,
including override order relative to other VPKs. Logs alone do not prove styling.
Click Invite with a small eligible list first: confirm native cards actually move
to the pending/invited category, successful and rejected result dialogs close,
and limited-user failures are skipped without a growing popup stack. Test delayed
replies and native processing dialogs; these are not validated by source reading.
Compare native counts before/after, including offline friends and lists requiring
scrolling. Check a large list, close the popup/Esc mid-run and reopen, and confirm
already invited friends are skipped. Capture frame times separately during idle
and sending; the offline model cannot validate rendering, server acceptance,
server throttling, lazy card creation or real FPS.

Only `panorama/` contains game assets. `tools/` and this README are development
files. Compilation, VPK packaging and installation are performed by the maintainer.
Use a full clean rebuild when upgrading from the old friends-list loader, and
replace its installed VPK so the removed `friends_list.vxml_c` cannot remain active.
