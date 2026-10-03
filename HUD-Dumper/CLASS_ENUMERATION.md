# Full native class enumeration: unresolved

The required result is the actual list of every class attached to each live
panel, associated with that panel in the captured hierarchy. Matching a fixed
list of class names, reading XML alone, or logging future JavaScript class writes
does not meet this requirement.

## Confirmed client evidence

The vanilla early bot-match capture `mus35lzj-1` contains 25,827 panels and reports
`classesIncomplete: 25827`, `GetClassesUnavailable: 25827`, and zero collected
classes. Its 887 transport batches were received and verified. Transport loss
does not explain the missing classes. The capture did collect the hierarchy and
Label text. Empty class arrays in this file mean unavailable data, not panels
with no classes.

The collector's Node fixtures define `GetClasses()` themselves. QOLLOCK's
simulator also defines it, while QOLLOCK runtime callers guard its presence.
Neither provides evidence of an engine getter, and QOLLOCK does not install that
method on native panels. Running without QOLLOCK therefore does not account for
the failed getter. The original implementation and its README incorrectly
treated this method as available in the game.

The subsequent delayed client API probe completed without reflection errors or
truncation. The HUD context (`Panel`), `Hud` (`CitadelHud`), and two immediate HUD
children exposed identical sets of 117 own names (89 functions) and 129 names
including their prototype chains. Direct lookup reported `GetClasses:undefined`
on all four. The reflected class operations mutate classes or test named
membership; no explicit class-list method or class-list property appeared.
The `$` surface exposed 29 own functions without a class-list API. This is live
client evidence, not merely a DLL string search. It does not rule out indirect
access through other APIs or a different native control.

The controlled client experiment in `hud_api_probe.js` also completed. Its owned
temporary panel had neither test class initially; `BHasClass` then confirmed A,
both A and B, and only B after removing A. `GetAttributeString("class",
"<missing>")` returned `<missing>` in every state. This getter does not expose
the current class list for that native Panel. The log confirms that deletion of
the temporary panel was requested, not that asynchronous deletion completed.
The collector must not switch to this getter as a source of live classes.

## Native debugger evidence

The extracted core resources include `panorama/layout/debugger.xml`,
`debuglayout.xml`, and `debugpanel.xml`. `DebugLayout` is a native control; its row
snippet includes the `DebugLayoutPanelOpen` Label. These resources do not contain
a JavaScript tree-export implementation or a full-class getter.

The installed `panoramauiclient.dll` contains the native diagnostic names
`CDebugLayout::AppendElementOpenTag` and its `GetDebugPropertyInfo` stage, alongside
markup-formatting strings. These are investigation leads for the native
inspector's panel descriptions. They do not establish a callable JavaScript
method, a supported export, or that all collapsed descendants are materialized
as readable debugger rows.

Further read-only inspection followed the virtual call at that stage rather than
relying on the diagnostic strings alone. In the inspected binaries,
`CPanel2D` forwards this call to its underlying `CUIPanel`. That target creates a
debug property named `class`, iterates the panel's stored symbol array, resolves
the symbol names, and joins them with spaces. This establishes a native path
for producing the per-panel class description used by the inspector. It does
not establish a JavaScript binding or a supported tree-export operation.

For reproducibility, the traced RVAs in the inspected Windows binaries were:
`panoramauiclient.dll` `0x12257e` (debug-description virtual call), `0xcf890`
(`CPanel2D` forwarding function), and `panorama.dll` `0x107eb0` (target function),
with the class-symbol loop at `0x108000` through `0x10814f`. These are static
investigation evidence for this binary version, not addresses to call or offsets
to use in runtime code. They must not be treated as a stable engine contract.

The same binary contains the panel binding-name block with `AddClass`,
`RemoveClass`, `BHasClass`, `Children`, and attribute methods. No `GetClasses` or
`GetClassNames` string was found in either installed Panorama DLL. String absence
is supporting evidence; the all-panel client result is the direct evidence for
`GetClasses` being unavailable in this capture.

`GetCycleClassStrByIndex` appears next to cycle-control methods and is not evidence
of a generic panel class enumerator. `panorama_print_render_tree` describes a
RenderOperation tree, not a panel/class export. `panorama_dump_symbols` describes
an engine-wide symbol table, not per-panel class membership. None has been
implemented here as a substitute for a native class-list export.

## Remaining verification

An experimental `debuglayout.xml` override now includes `hud_debugger_probe.js`
inside the native inspector resource. It attempts a bounded read of the current
debugger row Labels and prints raw samples to the game console. The script's
loading in this core UI context and its native row access remain unverified.
This is a candidate data-source test, not a full exporter. The completed HUD API
probe is retained in source but removed from the default HUD includes.

A usable native inspector export or another verified native enumeration bridge
must expose panel identity, parent/child relationships, and the complete current
class list. Before integrating it, verify that it includes collapsed descendants,
dynamically created panels, and classes assigned by native game code. A native
client comparison is required; mock tests cannot prove these properties.

The existing streaming sender and receiver can carry such data once a real source
is established. A working full-class source has not yet been established.
