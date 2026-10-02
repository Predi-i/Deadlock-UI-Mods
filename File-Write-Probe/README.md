# File Write Probe (CEF Web Primitives)

This diagnostic mod checks whether the embedded browser can create or download a text file using standard web workarounds (anchor download, blob download, File System Access API, Origin Private File System, and WebKit FileSystem).

## Run

1. Keep the file from the read probe at `C:\Users\Public\Documents\DeadlockFileProbe.txt`.
2. Confirm that `DeadlockWriteProbe-FE223F1D.txt` does not exist in `C:\Users\Public\Documents\` and is not in your `Downloads` folder.
3. Compile and install **File-Write-Probe** by itself (replaces `base_hud.xml`).
4. Load into a match or practice range and wait 12 seconds.
5. Check the HUD label and console logs for `[FILEWRITE]`.
6. Also check whether `DeadlockWriteProbe-FE223F1D.txt` appeared in `%USERPROFILE%\Downloads`.
