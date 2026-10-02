(() => {
  "use strict";
  const api = $.DjinnMark;
  const root = $.GetContextPanel();
  if (root.__djinnPublisher) root.__djinnPublisher.stop();
  const relay = $.DjinnMarkCreateRelay();
  let stopped = false;
  let effects = null;
  let namePanel = null;
  let lastKey = "";
  let lastStacks = 0;
  let markPanels = new Map();
  const stop = () => {
    stopped = true;
    relay.stop();
  };
  root.__djinnPublisher = { stop };
  const publish = (key, stacks, clip = null) => {
    const now = Date.now();
    const record = { magic_word: api.magic, version: 2, key, stacks, clip,
      updated_at: now, expires_at: now + 3000 };
    relay.send(record);
  };
  const tick = () => {
    if (stopped) return;
    if (!api.valid(root)) { stop(); return; }
    try {
      // v2 moved StatusEffects out of UnitStatus. Both paths are native XML.
      const unit = api.child(root, "UnitStatus");
      if (!api.valid(effects)) effects = api.child(root, "StatusEffects") || api.child(unit, "StatusEffects");
      if (!api.valid(namePanel)) namePanel = api.child(root, "name") || api.child(api.child(unit, "NameVoiceContainer"), "name");
      const key = api.readName(namePanel, "{s:name}");
      let stacks = 0;
      let clip = null;
      const currentPanels = new Map();
      if (key && api.valid(effects)) {
        // Keep this tiny engine-owned subtree traversal: a HUD capture does not
        // establish whether world StatusEffects inserts an internal wrapper.
        for (const mark of effects.FindChildrenWithClassTraverse("sand_phantom_passive_victim")) {
          if (!api.valid(mark) || mark.visible === false) continue;
          let panels = markPanels.get(mark);
          if (!panels || !api.valid(panels.label) || !api.valid(panels.border)) {
            const container = mark.Children().find(panel => panel.BHasClass("statusEffectContainer"));
            panels = { label: api.child(mark, "stacks"), border: api.child(container, "StatusEffectsBorder") };
          }
          currentPanels.set(mark, panels);
          const label = panels.label;
          const text = api.valid(label) ? String(label.text).trim() : "";
          const count = text ? Number(text) : NaN;
          const nextStacks = Number.isInteger(count) && count >= 0 ? count : 1;
          if (nextStacks >= stacks) {
            stacks = nextStacks;
            const border = panels.border;
            clip = api.valid(border) ? api.readClip(border.style.clip) : null;
          }
        }
      }
      markPanels = currentPanels;
      if (lastKey && lastKey !== key && lastStacks > 0) publish(lastKey, 0);
      // Refresh active snapshots for late subscribers and expire missing sources.
      if (key && (stacks > 0 || (lastKey === key && lastStacks > 0))) publish(key, stacks, clip);
      lastKey = key;
      lastStacks = stacks;
      $.Schedule(!api.valid(effects) || !key ? 1.0 : stacks > 0 ? 0.05 : 0.4, tick);
    } catch (error) {
      $.Schedule(1.0, tick);
    }
  };
  $.Schedule(0.1, tick);
})();
