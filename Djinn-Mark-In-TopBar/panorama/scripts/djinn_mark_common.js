(() => {
  "use strict";
  const valid = panel => !!panel && panel.IsValid();
  const find = (panel, id) => valid(panel) ? panel.FindChildTraverse(id) : null;
  const child = (panel, id) => valid(panel) ? panel.Children().find(node => valid(node) && node.id === id) || null : null;
  const normalize = value => {
    const name = String(value || "").replace(/\s+/g, " ").trim();
    return !name || name === "#" || /[{}%]/.test(name) ? "" : name.toLowerCase();
  };
  const readName = (panel, token) => {
    if (!valid(panel)) return "";
    const text = normalize(panel.text);
    if (text && text[0] !== "#") return text;
    const localized = normalize($.Localize(token, panel));
    return localized && localized[0] !== "#" ? localized : "";
  };
  // Engine-owned countdown mask; do not guess the ability's duration.
  const readClip = value => {
    const match = /^radial\(\s*50(?:\.0+)?%\s+50(?:\.0+)?%\s*,\s*0(?:\.0+)?deg\s*,\s*(-?\d+(?:\.\d+)?)deg\s*\)$/.exec(String(value || ""));
    const angle = match ? Number(match[1]) : NaN;
    return Number.isFinite(angle) && angle >= -360 && angle <= 0 ?
      "radial(50% 50%, 0deg, " + angle + "deg)" : null;
  };
  $.DjinnMark = { valid, find, child, normalize, readName, readClip,
    channel: "ClientUI_FireOutput", magic: "DJINN_MARK_UPDATE" };
})();
