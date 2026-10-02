// Canonical source copied into standalone mods by tools/sync_hud_lookup.py.
// Scope paths verified against the October 1 HUD capture and native layouts.
(() => {
    'use strict';
    const valid = panel => !!(panel && panel.IsValid());
    let hud = null;
    let core = null;
    const cache = new Map();
    const routes = {
        GameTime: ['TopBar'],
        ChatInput: ['Chat', 'ChatControls'],
        ChatTargetLabel: ['Chat', 'ChatControls'],
        damageImpactInfo: ['damage_impact'],
        respawn_timer: ['gameplay_hud_dead'],
        gun_data: ['gameplay_hud', 'gameplay_hud_alive', 'crosshair', 'gun'],
        BuffModifiers: ['gameplay_hud', 'gameplay_hud_alive', 'status_bars', 'hud_modifiers'],
        slot_signature_3: ['AbilitiesContainer', 'hud_signature'],
        hud_minimap: ['gameplay_hud', '.clamp_width', 'minimap_persp', 'minimap_container', 'HudMinimapContainer'],
        minimap_container: ['gameplay_hud', '.clamp_width', 'minimap_persp'],
    };
    const hudRoutes = {
        EscapeMenu: [],
        EscapeBackground: ['EscapeMenu'],
        Menu: ['EscapeMenu', 'LeftStripe'],
        SubOptions: ['EscapeMenu', 'LeftStripe', 'Menu'],
        CitadelPartyContainer: [],
    };
    const child = (panel, id) => valid(panel)
        ? (panel.Children() || []).find(node => valid(node) && node.id === id) || null : null;
    const find = id => {
        if (!valid(hud)) {
            let panel = $.GetContextPanel();
            hud = null;
            for (let i = 0; valid(panel) && i < 50; i++) {
                if (panel.id === 'Hud') { hud = panel; break; }
                panel = panel.GetParent();
            }
            // base_hud scripts belong to the WindowRoot, which owns Hud directly.
            if (!hud) hud = child($.GetContextPanel(), 'Hud');
            core = null;
            cache.clear();
        }
        if (id === 'Hud') return hud;
        if (Object.prototype.hasOwnProperty.call(hudRoutes, id)) {
            if (valid(cache.get(id))) return cache.get(id);
            let panel = hud;
            for (const step of hudRoutes[id]) panel = child(panel, step);
            const found = child(panel, id);
            if (found) cache.set(id, found);
            return found;
        }
        if (!valid(core)) {
            core = valid(hud) ? hud.Children().find(panel => panel.BHasClass('HudCore')) : null;
            cache.clear();
        }
        if (!valid(core)) return null;
        if (valid(cache.get(id))) return cache.get(id);
        const direct = child(core, id);
        if (direct) { cache.set(id, direct); return direct; }
        const route = routes[id];
        if (!route) return null;
        let scope = core;
        for (const step of route) {
            scope = step.charAt(0) === '.'
                ? scope.Children().find(panel => valid(panel) && panel.BHasClass(step.substring(1)))
                : child(scope, step);
            if (!scope) return null;
        }
        // Anonymous wrappers in these small native subtrees have no stable ID.
        // Never fall back to traversing Hud/HudCore if a scope is missing.
        const found = child(scope, id) || scope.FindChildTraverse(id);
        if (valid(found)) cache.set(id, found);
        return valid(found) ? found : null;
    };
    $.ModHudLookup = { find };
})();
