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

A usable native inspector export or another verified native enumeration bridge
must expose panel identity, parent/child relationships, and the complete current
class list. Before integrating it, verify that it includes collapsed descendants,
dynamically created panels, and classes assigned by native game code. A native
client comparison is required; mock tests cannot prove these properties.

The existing streaming sender and receiver can carry such data once a real source
is established. A working full-class source has not yet been established.
