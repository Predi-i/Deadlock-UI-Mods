<#
.SYNOPSIS
    Build a mod with all comments stripped from its shipped panorama files.

.DESCRIPTION
    Wraps build_mod.ps1. It never edits your working tree: the chosen mod folder is
    copied to a staging directory, comments are removed from the COPY, and build_mod.ps1
    is pointed at that. So the VPK ships without comments while the repo keeps them.

    Stripped in place, per file type:
      .js  -> // line comments and /* block */ comments
      .css -> /* block */ (CSS has no line comments)
      .xml -> <!-- block -->

    The JS stripper is string-, template-, and regex-aware, so a "//" inside a string
    or a "/" inside a regex literal is never mistaken for a comment. Every stripped .js
    is then re-parsed; if stripping would have broken a file, the ORIGINAL is restored
    and the build is aborted rather than shipping a syntax error.

    Replaces Minigames/tools/strip_comments.js, which was Minigames-only, had to be run
    by hand against an already-built tree, silently mangled a regex literal that followed
    a keyword (`return /"/.test(s)` became an unterminated string), and ate `/*` inside a
    CSS url() string.

.PARAMETER ModFolderName
    Mod folder to build (e.g. Minigames). Prompted for if omitted, same as build_mod.ps1.

.PARAMETER Force
    Passed through to build_mod.ps1 (full rebuild, ignore the incremental cache).

.PARAMETER KeepStaging
    Leave the stripped copy on disk for inspection instead of deleting it.

.PARAMETER DryRun
    Strip into staging and report the savings, then stop without building.

.EXAMPLE
    .\build_mod_strip_comments.ps1 Minigames
.EXAMPLE
    .\build_mod_strip_comments.ps1 Minigames -DryRun
#>
[CmdletBinding()]
param(
    [string]$ModFolderName,
    [switch]$Force,
    [switch]$KeepStaging,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$Host.UI.RawUI.WindowTitle = "Deadlock Mod Compiler (comments stripped)"

$ScriptDir = (Resolve-Path "$PSScriptRoot").Path
$RepoRoot = (Resolve-Path "$ScriptDir\..").Path
$BuildScript = Join-Path $ScriptDir "build_mod.ps1"

if (-not (Test-Path $BuildScript)) {
    Write-Host "ERROR: build_mod.ps1 not found next to this script ($ScriptDir)." -ForegroundColor Red
    exit 1
}

# ==============================================================================
# COMMENT STRIPPERS
# ==============================================================================

# JS: walk the source one character at a time, tracking whether we are inside a string,
# a template literal, a regex literal or a comment, so only real comment bytes are dropped.
function Remove-JsComments {
    param([string]$Source)

    # Does a '/' at this point start a regex literal, or is it division? A regex may only
    # appear where an expression may START, so we look at the previous significant token.
    # The old JS implementation only looked at the previous CHARACTER, which made it treat
    # `return /"/.test(s)` as division and then swallow the rest of the line as a comment.
    # Keywords have to be handled explicitly, hence the word list.
    $regexKeywords = @(
        'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw',
        'case', 'do', 'else', 'yield', 'await'
    )
    $out = New-Object System.Text.StringBuilder

    function Test-RegexAllowed {
        param([System.Text.StringBuilder]$Built, [string[]]$Keywords)
        $s = $Built.ToString()
        $j = $s.Length - 1
        while ($j -ge 0 -and ($s[$j] -eq ' ' -or $s[$j] -eq "`t" -or $s[$j] -eq "`n" -or $s[$j] -eq "`r")) { $j-- }
        if ($j -lt 0) { return $true }                      # start of file
        $c = $s[$j]
        if ('(,=:[!&|?{};+-*%^~<>'.IndexOf($c) -ge 0) { return $true }
        # An identifier ends here: a regex is legal only if that identifier is a keyword.
        if ([char]::IsLetter($c) -or $c -eq '_' -or $c -eq '$') {
            $k = $j
            while ($k -ge 0 -and ([char]::IsLetterOrDigit($s[$k]) -or $s[$k] -eq '_' -or $s[$k] -eq '$')) { $k-- }
            $word = $s.Substring($k + 1, $j - $k)
            return ($Keywords -contains $word)
        }
        return $false
    }

    $i = 0
    $n = $Source.Length
    while ($i -lt $n) {
        $c = $Source[$i]
        $d = if ($i + 1 -lt $n) { $Source[$i + 1] } else { [char]0 }

        if ($c -eq '/' -and $d -eq '/') {                   # line comment
            $i += 2
            while ($i -lt $n -and $Source[$i] -ne "`n") { $i++ }
            continue
        }
        if ($c -eq '/' -and $d -eq '*') {                   # block comment
            $i += 2
            while ($i -lt $n -and -not ($Source[$i] -eq '*' -and ($i + 1 -lt $n) -and $Source[$i + 1] -eq '/')) { $i++ }
            $i += 2
            continue
        }
        if ($c -eq '"' -or $c -eq "'" -or $c -eq '`') {      # string / template literal
            $quote = $c
            [void]$out.Append($c)
            $i++
            while ($i -lt $n) {
                $ch = $Source[$i]
                [void]$out.Append($ch)
                if ($ch -eq '\') {
                    if ($i + 1 -lt $n) { [void]$out.Append($Source[$i + 1]) }
                    $i += 2
                    continue
                }
                $i++
                if ($ch -eq $quote) { break }
            }
            continue
        }
        if ($c -eq '/' -and (Test-RegexAllowed -Built $out -Keywords $regexKeywords)) {
            [void]$out.Append($c)
            $i++
            $inClass = $false
            while ($i -lt $n) {
                $rc = $Source[$i]
                [void]$out.Append($rc)
                if ($rc -eq '\') {
                    if ($i + 1 -lt $n) { [void]$out.Append($Source[$i + 1]) }
                    $i += 2
                    continue
                }
                if ($rc -eq '[') { $inClass = $true }
                elseif ($rc -eq ']') { $inClass = $false }
                $i++
                if ($rc -eq '/' -and -not $inClass) { break }
            }
            continue
        }
        [void]$out.Append($c)
        $i++
    }
    return (Compress-BlankLines $out.ToString())
}

# CSS / XML: a single block-comment form, but still string-aware — a CSS url("a/*b*/c.png")
# must survive untouched (the old JS version silently corrupted exactly that).
function Remove-BlockComments {
    param([string]$Source, [string]$Open, [string]$Close, [switch]$StringAware)

    $out = New-Object System.Text.StringBuilder
    $i = 0
    $n = $Source.Length
    while ($i -lt $n) {
        $c = $Source[$i]
        if ($StringAware -and ($c -eq '"' -or $c -eq "'")) {
            $quote = $c
            [void]$out.Append($c)
            $i++
            while ($i -lt $n) {
                $ch = $Source[$i]
                [void]$out.Append($ch)
                if ($ch -eq '\') {
                    if ($i + 1 -lt $n) { [void]$out.Append($Source[$i + 1]) }
                    $i += 2
                    continue
                }
                $i++
                if ($ch -eq $quote) { break }
            }
            continue
        }
        if ($i + $Open.Length -le $n -and $Source.Substring($i, $Open.Length) -eq $Open) {
            $i += $Open.Length
            while ($i + $Close.Length -le $n -and $Source.Substring($i, $Close.Length) -ne $Close) { $i++ }
            $i += $Close.Length
            continue
        }
        [void]$out.Append($c)
        $i++
    }
    return (Compress-BlankLines $out.ToString())
}

# Drop lines left blank by comment-only lines and squeeze runs of blanks to one, so the
# shipped file still reads sanely if anyone opens it.
function Compress-BlankLines {
    param([string]$Text)

    $lines = $Text -split "`r?`n"
    $res = New-Object System.Collections.Generic.List[string]
    $prevBlank = $false
    foreach ($line in $lines) {
        $blank = [string]::IsNullOrWhiteSpace($line)
        if ($blank -and $prevBlank) { continue }
        $res.Add(($line -replace '[ \t]+$', ''))
        $prevBlank = $blank
    }
    while ($res.Count -gt 0 -and [string]::IsNullOrWhiteSpace($res[0])) { $res.RemoveAt(0) }
    while ($res.Count -gt 0 -and [string]::IsNullOrWhiteSpace($res[$res.Count - 1])) { $res.RemoveAt($res.Count - 1) }
    return (($res -join "`n") + "`n")
}

# Self-check: does this text still parse as JS? The Panorama engine will not tell us, so
# catching a mangled file HERE is the difference between a failed build and a broken mod.
# Uses node when available (it is a dev dependency of the Minigames mod anyway).
function Test-JsParses {
    param([string]$Path)

    if (-not $script:NodeAvailable) { return $true }        # no node: skip, don't block the build
    & node --check $Path 2>$null | Out-Null
    return ($LASTEXITCODE -eq 0)
}

# ==============================================================================
# MAIN
# ==============================================================================

$script:NodeAvailable = $null -ne (Get-Command node -ErrorAction SilentlyContinue)
if (-not $script:NodeAvailable) {
    Write-Host "NOTE: node not found on PATH - stripped .js files will NOT be syntax-checked." -ForegroundColor Yellow
}

# Pick the mod folder. Same list build_mod.ps1 shows, so the two scripts agree.
$SelectedMod = $ModFolderName
if ([string]::IsNullOrWhiteSpace($SelectedMod)) {
    $folders = Get-ChildItem -Path $RepoRoot -Directory | Where-Object {
        $_.Name -notmatch "^\." -and $_.Name -notin @("tools", "builds")
    }
    if ($folders.Count -eq 0) {
        Write-Host "ERROR: No mod folders found in $RepoRoot." -ForegroundColor Red
        exit 1
    }
    Write-Host "Build which mod (comments will be stripped from the VPK)?" -ForegroundColor Cyan
    for ($i = 0; $i -lt $folders.Count; $i++) {
        Write-Host "[$($i + 1)] $($folders[$i].Name)"
    }
    $picked = 0
    while ($picked -lt 1 -or $picked -gt $folders.Count) {
        $answer = Read-Host "Enter 1-$($folders.Count)"
        if ([int]::TryParse($answer, [ref]$null)) { $picked = [int]$answer }
    }
    $SelectedMod = $folders[$picked - 1].Name
}

$ModSourcePath = Join-Path $RepoRoot $SelectedMod
if (-not (Test-Path $ModSourcePath)) {
    Write-Host "ERROR: Mod folder '$SelectedMod' not found in $RepoRoot." -ForegroundColor Red
    exit 1
}

# Staging has to sit DIRECTLY under the repo root: build_mod.ps1 resolves a mod as
# "$PSScriptRoot\..\<ModFolderName>", so a copy hidden inside tools\ would be invisible to it
# and it would silently build the original, commented source instead. The staging folder is
# therefore a sibling of the real mod, named "<Mod>-stripped", and is deleted afterwards
# unless -KeepStaging. The VPK is named after it, which also keeps a stripped public build
# from overwriting your normal dev build.
$StagingName = "$SelectedMod-stripped"
$StagingMod = Join-Path $RepoRoot $StagingName
if (Test-Path $StagingMod) { Remove-Item -Recurse -Force $StagingMod }
New-Item -ItemType Directory -Force -Path $StagingMod | Out-Null

# Only the Source 2 content roots matter to the build; copying node_modules or .git into
# staging would waste minutes and pull dev clutter into the strip pass. Same whitelist
# build_mod.ps1 uses to decide what is a build input.
$ContentRoots = @(
    'panorama', 'soundevents', 'sounds', 'materials', 'models',
    'particles', 'scripts', 'resource', 'maps', 'shaders', 'vscripts'
)
$copiedRoots = 0
foreach ($rootName in $ContentRoots) {
    $src = Join-Path $ModSourcePath $rootName
    if (Test-Path $src) {
        Copy-Item -Path $src -Destination $StagingMod -Recurse -Force
        $copiedRoots++
    }
}
if ($copiedRoots -eq 0) {
    Write-Host "ERROR: '$SelectedMod' has no Source 2 content directories to build." -ForegroundColor Red
    exit 1
}

Write-Host "`n=== Stripping comments: $SelectedMod ===" -ForegroundColor Green
Write-Host "Staging: $StagingMod" -ForegroundColor DarkGray

$totalBefore = 0
$totalAfter = 0
$touched = 0
$failed = New-Object System.Collections.Generic.List[string]
$Utf8NoBom = New-Object System.Text.UTF8Encoding $false

$files = Get-ChildItem -Path $StagingMod -Recurse -File | Where-Object {
    $_.Extension -in @('.js', '.css', '.vcss', '.xml', '.vxml')
}
foreach ($file in $files) {
    $before = [System.IO.File]::ReadAllText($file.FullName)
    switch ($file.Extension) {
        '.js'   { $after = Remove-JsComments $before }
        '.css'  { $after = Remove-BlockComments -Source $before -Open '/*' -Close '*/' -StringAware }
        '.vcss' { $after = Remove-BlockComments -Source $before -Open '/*' -Close '*/' -StringAware }
        default { $after = Remove-BlockComments -Source $before -Open '<!--' -Close '-->' }
    }

    $totalBefore += $before.Length
    $totalAfter += $after.Length
    if ($after -eq $before) { continue }

    [System.IO.File]::WriteAllText($file.FullName, $after, $Utf8NoBom)

    # A stripped .js that no longer parses means the stripper hit a construct it does not
    # understand. Put the original back and remember it: shipping a syntax error would only
    # surface as a dead panel in-game, with nothing pointing at this script.
    if ($file.Extension -eq '.js' -and -not (Test-JsParses -Path $file.FullName)) {
        [System.IO.File]::WriteAllText($file.FullName, $before, $Utf8NoBom)
        $failed.Add($file.FullName.Substring($StagingMod.Length + 1))
        $totalAfter += ($before.Length - $after.Length)
        continue
    }

    $touched++
    $rel = $file.FullName.Substring($StagingMod.Length + 1)
    Write-Host ("  {0}  -{1} bytes" -f $rel, ($before.Length - $after.Length)) -ForegroundColor DarkGray
}

Write-Host ("`nStripped {0} files, {1} bytes removed." -f $touched, ($totalBefore - $totalAfter)) -ForegroundColor Green

if ($failed.Count -gt 0) {
    Write-Host "`nABORTING: stripping broke these files (originals were restored):" -ForegroundColor Red
    foreach ($f in $failed) { Write-Host "  $f" -ForegroundColor Red }
    Write-Host "The stripper hit JS it does not understand. Fix Remove-JsComments before shipping." -ForegroundColor Yellow
    exit 1
}

if ($DryRun) {
    Write-Host "`n-DryRun: nothing was built. Inspect the stripped copy at:" -ForegroundColor Cyan
    Write-Host "  $StagingMod" -ForegroundColor Cyan
    exit 0
}

# Hand the stripped copy to the real compiler. -Force is implied: the incremental cache is
# keyed per mod name and the staging tree is rebuilt every run, so a cached hash from a
# previous run would otherwise skip files.
Write-Host "`n=== Handing off to build_mod.ps1 ($StagingName) ===" -ForegroundColor Green
$buildExit = 1
try {
    & $BuildScript -ModFolderName $StagingName -Force
    $buildExit = $LASTEXITCODE
} finally {
    if (-not $KeepStaging) {
        Remove-Item -Recurse -Force $StagingMod -ErrorAction SilentlyContinue
    } else {
        Write-Host "`n-KeepStaging: stripped copy left at $StagingMod" -ForegroundColor Cyan
    }
}

exit $buildExit
