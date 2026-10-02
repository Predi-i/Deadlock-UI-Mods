// Adapted from Hantu-Raya's hp_colors_rewrite_v2/test_event_bridge.js.
// Copyright 2026 Hantu-Raya. Apache-2.0; see third-party/LICENSE and NOTICE.
// Modified: ES6, Djinn snapshot payloads, independent publisher lifecycle.
(() => {
  "use strict";
  const context = $.GetContextPanel();
  const attribute = "djinn_mark_message";
  if (context.BHasClass("DjinnMarkRelay")) {
    let last = "";
    const forward = () => {
      if (!context.IsValid()) return;
      const raw = context.GetAttributeString(attribute, "");
      if (!raw || raw === last) return;
      // Must run in this sibling's layout context, outside ClientUIDialogPanel.
      $.DispatchEvent("ClientUI_FireOutput", raw);
      last = raw;
    };
    context.SetPanelEvent("onactivate", forward);
    forward(); // Drain data written before asynchronous layout completion.
    return;
  }
  $.DjinnMarkCreateRelay = () => {
    let relay = null;
    return {
      send(record) {
        const parent = context.GetParent();
        if (!parent || !parent.IsValid()) throw new Error("Healthbar parent unavailable");
        if (!relay || !relay.IsValid()) {
          if (context.type !== "ClientUIDialogPanel" || parent.type !== "Panel") {
            throw new Error("Expected ClientUIDialogPanel under Panel; got " + context.type + "/" + parent.type);
          }
          relay = $.CreatePanel("Panel", parent, "DjinnMarkEventRelay");
          relay.AddClass("DjinnMarkRelay");
          try {
            if (!relay.BLoadLayout("file://{resources}/layout/djinn_mark_relay.xml", false, false))
              throw new Error("Djinn relay layout failed to load");
          } catch (error) {
            relay.DeleteAsync(0);
            relay = null;
            throw error;
          }
        }
        relay.SetAttributeString(attribute, JSON.stringify(record));
        $.DispatchEvent("Activated", relay, "mouse");
      },
      stop() {
        if (relay && relay.IsValid()) {
          relay.SetAttributeString(attribute, "");
          relay.DeleteAsync(0);
        }
        relay = null;
      }
    };
  };
})();
