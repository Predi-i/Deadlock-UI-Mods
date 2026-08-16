# Update relevance markers

`mg_ui.js` checks the marker for its embedded version directly from the `main` branch on
`raw.githubusercontent.com`.

- A square PNG means that version is still current. Relevant markers are 64x64.
- To retire a version, replace its marker with `outdated-template.png` (64x8), keeping the
  marker's filename unchanged.
- For a new release, bump `MG_VERSION`, copy `relevant-template.png` to the matching marker name
  (`is-1-1-relevant.png`, and so on), then commit and push both marker changes to `main`.

The next version's marker is staged one release ahead (`is-1-3-relevant.png` already exists while
1.2 ships), so a release only has to retire the previous marker. The popup is driven by the
OUTGOING version's marker: players on 1.1 are told to update because `is-1-1-relevant.png` was
replaced with the wide template, not because 1.2 exists. Retiring it is therefore the step that
actually notifies anyone; forgetting it ships a release nobody is prompted to install.

`mg_update_marker_test.js` also asserts that the marker for the current `MG_VERSION` exists and
classifies as current, so a bump cannot ship without its marker.

The client compares aspect ratio rather than literal dimensions because Panorama UI scaling can
multiply the reported width and height or swap them. Only the deliberately distant square and
very-wide ratio bands are accepted; intermediate shapes are treated as a failed check rather than
as an available update, which prevents malformed or unexpected images from causing a false popup.

`node tools/mg_update_marker_test.js` verifies both templates across simulated UI scales from
50% to 400%, every independent width/height measurement error from -2px to +2px, and swapped
dimensions. It also verifies that an ambiguous 2:1 image is rejected.
