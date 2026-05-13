(function() {
    'use strict';
    if ($._custom3dCardsRunning) return;
    $._custom3dCardsRunning = true;

    var HERO_MAP = {
        "holliday": "astro", "bebop": "bebop", "abrams": "bull", "mo & krill": "digger",
        "the doorman": "doorman", "drifter": "drifter", "mcginnis": "engineer",
        "rem": "familiar", "apollo": "fencer", "lady geist": "spectre", "haze": "haze",
        "infernus": "inferno", "kelvin": "kelvin", "lash": "lash", "sinclair": "magician",
        "mina": "vampirebat", "mirage": "mirage", "calico": "nano", "graves": "necro",
        "paradox": "chrono", "billy": "punkgoat", "dynamo": "sumo", "grey talon": "archer",
        "ivy": "tengu", "warden": "warden", "paige": "bookworm", "seven": "gigawatt",
        "shiv": "shiv", "pocket": "synth", "celeste": "unicorn", "venator": "priest",
        "victor": "frank", "vindicta": "hornet", "viscous": "viscous", "vyper": "kali",
        "wraith": "wraith", "yamato": "yamato", "silver": "werewolf"
    };

    function processBlocks(blocks) {
        if (!blocks) return;
        for (var i = 0; i < blocks.length; i++) {
            var block = blocks[i];
            if (!block || !block.IsValid()) continue;

            var nameLabels = block.FindChildrenWithClassTraverse("heroName");
            if (!nameLabels || nameLabels.length === 0 || !nameLabels[0].IsValid()) continue;

            var rawText = String(nameLabels[0].text || "").toLowerCase();
            if (!rawText) continue;

            if (block._lastProcessedText === rawText) continue;

            var heroInternalName = "";
            for (var key in HERO_MAP) {
                if (rawText.indexOf(key) !== -1) {
                    heroInternalName = HERO_MAP[key];
                    break;
                }
            }

            var vanillaImg = block.FindChildTraverse("HeroImage");
            if (!vanillaImg || !vanillaImg.IsValid()) continue;

            var parent = vanillaImg.GetParent();
            var custom3D = parent.FindChild("Custom3D_Overlay");

            if (heroInternalName) {
                var isSmall = (block.paneltype === "CitadelMatchHistoryBlockSmall") || 
                              block.BHasClass("gameMiniBlock") || 
                              block.BHasClass("CitadelMatchHistoryBlockSmall");

                var suffix = isSmall ? "_4d_psd.vtex" : "_3d_psd.vtex";
                var targetUrl = "url('s2r://panorama/images/heroes/" + heroInternalName + suffix + "')";

                if (!custom3D || !custom3D.IsValid()) {
                    custom3D = $.CreatePanel("Panel", parent, "Custom3D_Overlay");
                    custom3D.AddClass("heroImg");
                    custom3D.style.zIndex = "0";
                }

                custom3D.style.backgroundImage = targetUrl;
                custom3D.style.backgroundSize = "cover";
                custom3D.style.backgroundPosition = "50% 50%";
                custom3D.style.visibility = "visible";
                vanillaImg.style.opacity = "0";
            } else {
                if (custom3D) custom3D.style.visibility = "collapse";
                vanillaImg.style.opacity = "1";
            }

            block._lastProcessedText = rawText;
        }
    }

    var _root = null;
    function loop() {
        if (!_root || !_root.IsValid()) {
            var ctx = $.GetContextPanel();
            while (ctx && ctx.GetParent()) { ctx = ctx.GetParent(); }
            _root = ctx;
        }

        if (_root) {
            processBlocks(_root.FindChildrenWithClassTraverse("MatchBlockBig"));
            processBlocks(_root.FindChildrenWithClassTraverse("matchBlock"));
            processBlocks(_root.FindChildrenWithClassTraverse("gameMiniBlock"));
            processBlocks(_root.FindChildrenWithClassTraverse("CitadelMatchHistoryBlockSmall"));
        }
        
        $.Schedule(0.1, loop);
    }

    loop();
})();