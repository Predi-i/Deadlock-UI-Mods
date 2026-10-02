# File Read Probe

This diagnostic mod checks whether a Deadlock HUD mod can read a text file outside the game and mod directories through `CitadelHTMLPanel`. It makes no network requests and only reports a 16-character test marker to Panorama.

## Prepare and run

1. Create `C:\Users\Public\Documents\DeadlockFileProbe.txt` as UTF-8 plain text containing one line in this format: `DL_FILE_PROBE_0123456789ABCDEF`. Use any 16 uppercase hexadecimal characters after the prefix.
2. Compile and install **File-Read-Probe** as a standalone mod. Its `base_hud.xml` override can conflict with other mods that replace the same layout, so test it by itself.
3. Load a match or practice range. Read the status in the upper left of the HUD or filter the game console for `FILEPROBE`.

`READ OK` means the browser rendered the test file and page JavaScript returned its marker through `HTMLTitle`. `NO_MARKER` means the injected script ran, but the visible document did not contain the expected line. `NO READ` means no valid marker was returned; the console and Panorama Debugger are needed to distinguish a load failure from a blocked `javascript:` URL.

This test does not establish whether a page loaded from `file:///` can send data over the network. That needs a separate, opt-in test using only this marker.
