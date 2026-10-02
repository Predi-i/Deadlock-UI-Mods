# Djinn's Mark In TopBar

Shows the observed Djinn's Mark count below the matching enemy portrait.
The publisher supports the included old, modern and v2 healthbar overlay layouts,
including the October 2026 v2 health/shield and Rat King armor markup.

## Transport

The reference is Hantu-Raya's HP Colors v2 implementation:
- hp_colors_rewrite_v2/panorama/scripts/test_event_bridge.js
- hp_colors_rewrite_v2/panorama/scripts/test_topbar_pickups.js
- hp_colors_rewrite_v2/panorama/layout/test_event_relay.xml

ClientUIDialogPanel consumes its own ClientUI_FireOutput events. A world
healthbar therefore cannot send directly to the HUD with that event.

djinn_mark_relay.js creates a plain Panel **beside** the healthbar's
ClientUIDialogPanel, under its plain Panel parent. It loads djinn_mark_relay.xml
so its callback belongs to an independent layout context. The healthbar writes
a JSON snapshot to the sibling's native string attribute and activates it.
The sibling dispatches ClientUI_FireOutput from its own context; topbar cards
receive and render the snapshot. A callback created in the publisher context
would not provide this boundary, even if attached to another panel.

This is the reference's relay design adapted to ES6 and Djinn snapshots.
The adaptation and upstream license/notice are identified in djinn_mark_relay.js
and third-party/. No HP Colors settings or other features are required.

## Detection and rendering

- The source scans its own StatusEffects for sand_phantom_passive_victim and
  reads stacks. It reads name from the label or its dialog variable.
- All three overlay layouts include common helpers, relay, then publisher. The relay
  supports the old layout's nested name placement and v2's top-level StatusEffects.
  Source lookup uses direct child paths, and stack labels/countdown masks are cached
  per mark with invalidation when native panels are replaced.
- Cards match exact normalized hero/player names, rereading them after onload
  and when reused. Duplicate names cannot be resolved as distinct entities.
- Panels and a Label in StatusRow render the badge. Native CitadelStatusEffect,
  CustomUIConfig, root-attribute transport, and speculative hero-ID lookup are
  not used.
- Active/idle polling is 0.05/0.4 seconds; missing sources retry after
  1 second. Active snapshots refresh a 3000 ms freshness TTL. Clearing a mark
  or reusing the source clears the old key. A vanished source expires.
- Reload stops the previous publisher/receiver; a stopped publisher deletes
  its relay. Events update the badge without starting new polling chains.
- Dead cards and the scoreboard hide the badge; CSS restricts it to enemy cards.

## Packaging and validation

Compile/repack the entire mod, including the new relay XML and JS. Merely
updating the publisher/consumer will not install the relay layout.

    node Djinn-Mark-In-TopBar/tests/djinn_mark.test.cjs
    node Djinn-Mark-In-TopBar/tests/djinn_mark.test.cjs --delayed-layout
    node Djinn-Mark-In-TopBar/tests/djinn_mark.test.cjs --old-layout
    node Djinn-Mark-In-TopBar/tests/djinn_mark.test.cjs --modern-layout

Tests model separate world/HUD roots, separate JS contexts, absent GameUI, and
ClientUIDialogPanel consuming FireOutput. They cover immediate/delayed relay
layout loading, late identity/subscribers, unrelated cards, stacks, clearing,
zero, death, expiry, source/card reuse, reload, and cleanup.

This verifies our model and JavaScript behavior, not live Panorama rendering.
After repacking, mark an enemy using each healthbar style. Verify the matching
enemy topbar badge, stacks, native countdown mask, expiry, death and reused unit
panels. Normal operation is quiet; relay setup errors are logged explicitly.
