# Old Progress Bars

Keeps native text-progress IDs (`text_container`, `ability_name`,
`ability_name_clipped`) available for C++ bindings while adding the classic
`bar_fg` progress-context bar and caption. Modifier entries likewise retain both
native fancy and basic branches. Shared classic visibility rules use the
`channel_and_name` scope to outrank hero-specific single-ID selectors; each
vendored ability stylesheet imports those rules so dynamic style loading does
not restore the fancy branch.

The classic urn caption is collapsed by default and appears only under the native
`MODIFIER_STATE_HOLDING_IDOL` modifier. Other ability/modifier bars never carry the
caption. No unconditional "Visible to Enemies" warning is added; native visibility
conditions must not be replaced with a permanently visible duplicate label.

This preserves source bindings but requires client verification after repacking:
check all Fencer abilities separately, other affected heroes, modifier-channel
bars and urn text. XML validation cannot prove native progress animation.
