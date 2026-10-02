(() => {
  "use strict";
  const api = $.DjinnMark;
  const root = $.GetContextPanel();
  if (root.__djinnConsumer) root.__djinnConsumer.stop();
  const records = Object.create(null);
  let stopped = false;
  let badge = null;
  let label = null;
  let hero = null;
  let player = null;
  let border = null;
  let lastClip;
  let lastStacks = -1;
  const render = () => {
    if (stopped || !api.valid(root)) return;
    if (!api.valid(badge)) { badge = api.find(root, "TopbarDjinnMark"); lastStacks = -1; }
    if (!api.valid(label)) { label = api.find(root, "DjinnMarkStacks"); lastStacks = -1; }
    const names = api.child(root, "PlayerNameNWContainer") || root;
    if (!api.valid(hero)) hero = api.find(names, "HeroName");
    if (!api.valid(player)) player = api.find(names, "PlayerName");
    if (!api.valid(border)) { border = api.find(root, "DjinnMarkBorder"); lastClip = undefined; }
    if (!api.valid(badge) || !api.valid(label)) return;
    const now = Date.now();
    for (const key of Object.keys(records)) {
      if (records[key].expires_at <= now) delete records[key];
    }
    const heroName = api.readName(hero, "{s:hero_name}");
    const playerName = api.readName(player, "{s:player_name}");
    const record = records[heroName] || records[playerName];
    const stacks = !root.BHasClass("Dead") && record ? record.stacks : 0;
    const clip = stacks > 0 ? api.readClip(record.clip) : null;
    if (api.valid(border) && clip !== lastClip) {
      border.style.clip = clip || "radial(50% 50%, 0deg, 0deg)";
      border.style.visibility = clip ? "visible" : "collapse";
      lastClip = clip;
    }
    if (stacks === lastStacks) return;
    badge.SetHasClass("TopbarDjinnMarkVisible", stacks > 0);
    label.text = stacks > 0 ? String(stacks) : "";
    lastStacks = stacks;
  };
  const receive = message => {
    let record;
    try { record = typeof message === "string" ? JSON.parse(message) : message; }
    catch (error) { return false; }
    if (!record || record.magic_word !== api.magic || record.version !== 2 ||
        typeof record.key !== "string" || !record.key || api.normalize(record.key) !== record.key ||
        !Number.isInteger(record.stacks) || record.stacks < 0 ||
        !Number.isFinite(record.updated_at) || !Number.isFinite(record.expires_at) ||
        record.updated_at > Date.now() || record.expires_at <= Date.now()) return false;
    const previous = records[record.key];
    if (previous && previous.updated_at > record.updated_at) return false;
    records[record.key] = record;
    render();
    return false; // Do not consume a channel shared with other mods/cards.
  };
  const listener = $.RegisterForUnhandledEvent(api.channel, receive);
  const stop = () => {
    stopped = true;
    $.UnregisterForUnhandledEvent(api.channel, listener);
  };
  const tick = () => {
    if (stopped) return;
    if (!api.valid(root)) { stop(); return; }
    render();
    $.Schedule(lastStacks > 0 ? 0.05 : 0.4, tick);
  };
  root.__djinnConsumer = { stop };
  $.DjinnMarkPlayerLoaded = render;
  $.Schedule(0.15, tick);
})();
