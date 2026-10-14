param([string]$BuilderPath = (Join-Path $PSScriptRoot '../build_mod.ps1'))
$ErrorActionPreference = 'Stop'
$source = [IO.File]::ReadAllText((Resolve-Path -LiteralPath $BuilderPath).Path)
$tokens = $null
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
. (Join-Path (Split-Path $BuilderPath) 'build_mod_helpers.ps1')
$decoder = ${function:Convert-Mp3ToWav}
$compiledPathFunction = $ast.Find({ param($node)
    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-CompiledOutputPath'
}, $true)
. ([scriptblock]::Create($compiledPathFunction.Extent.Text))
function Assert-True($Condition, $Message) { if (-not $Condition) { throw $Message } }

# Exercise the real decoder's error handling with an in-memory fake FFmpeg.
& {
    $script:decodeFiles = @{}
    $script:decodeExit = 0
    $script:decodeLength = 100
    $script:ffmpegMissing = $false
    $script:decodeArguments = @()
    function Get-Command {
        if (-not $script:ffmpegMissing) { [pscustomobject]@{ Source = 'Invoke-TestFfmpeg' } }
    }
    function Invoke-TestFfmpeg {
        $script:decodeArguments = $args
        $script:decodeFiles[$args[-1]] = $script:decodeLength
        $global:LASTEXITCODE = $script:decodeExit
    }
    function Test-Path { param($LiteralPath, $PathType) $script:decodeFiles.ContainsKey($LiteralPath) }
    function Get-Item { param($LiteralPath) [pscustomobject]@{ Length = $script:decodeFiles[$LiteralPath] } }
    function Move-Item {
        param($LiteralPath, $Destination, [switch]$Force, $ErrorAction)
        $script:decodeFiles[$Destination] = $script:decodeFiles[$LiteralPath]
        $script:decodeFiles.Remove($LiteralPath)
    }
    function Remove-Item {
        param($LiteralPath, [switch]$Force, $ErrorAction)
        $script:decodeFiles.Remove($LiteralPath)
    }
    $destination = Join-Path ([IO.Path]::GetTempPath()) 'sound output.wav'
    & $decoder -Source 'source with spaces.mp3' -Destination $destination
    Assert-True ($script:decodeFiles[$destination] -eq 100 -and $script:decodeFiles.Count -eq 1) 'Decoded WAV not installed or temporary file leaked'
    Assert-True ($script:decodeArguments -contains 'pcm_s16le' -and $script:decodeArguments -contains 'source with spaces.mp3') 'PCM format or source argument lost'
    Assert-True (-not ($script:decodeArguments -contains '-ar') -and -not ($script:decodeArguments -contains '-ac')) 'Sample rate or channel count changed'
    foreach ($mode in @('failure', 'empty', 'missing')) {
        $script:decodeExit = if ($mode -eq 'failure') { 1 } else { 0 }
        $script:decodeLength = if ($mode -eq 'empty') { 44 } else { 200 }
        $script:ffmpegMissing = $mode -eq 'missing'
        $message = ''
        try { & $decoder -Source 'bad.mp3' -Destination $destination } catch { $message = $_.ToString() }
        Assert-True ($message.Length -gt 0 -and $script:decodeFiles[$destination] -eq 100 -and $script:decodeFiles.Count -eq 1) "Decoder $mode damaged the previous WAV or leaked a temporary file"
        if ($mode -eq 'missing') { Assert-True ($message.Contains('FFmpeg') -and $message.Contains('PATH')) 'Missing FFmpeg error lacks installation guidance' }
    }
}

# Run only the builder's staging and orphan cleanup blocks, never the builder,
# compiler, packer, or real filesystem operations.
$start = $source.IndexOf('        $Utf8NoBom =')
$end = $source.IndexOf('        $KeysToRemove =', $start)
$stageBlock = [scriptblock]::Create($source.Substring($start, $end - $start))
$start = $end
$end = $source.IndexOf('        # CSDK resolves descriptor dependencies.', $start)
$cleanupBlock = [scriptblock]::Create($source.Substring($start, $end - $start))
$ModSourcePath = Join-Path ([IO.Path]::GetTempPath()) 'mp3 source'
$TempContent = Join-Path ([IO.Path]::GetTempPath()) 'mp3 content'
$TempGame = Join-Path ([IO.Path]::GetTempPath()) 'mp3 game'
$SelectedMod = 'Audio-Test'
$script:files = @{}
$script:conversions = 0
$script:conversionFailure = $false
function Get-Item {
    param($LiteralPath)
    [pscustomobject]@{ FullName = $LiteralPath; Name = (Split-Path $LiteralPath -Leaf); Extension = [IO.Path]::GetExtension($LiteralPath); Length = $script:files[$LiteralPath] }
}
function Get-ChildItem {
    param($Path, $LiteralPath, [switch]$Recurse, [switch]$File)
    if ($LiteralPath) { $Path = $LiteralPath }
    foreach ($name in @($script:files.Keys)) {
        if ($name.StartsWith($Path + [IO.Path]::DirectorySeparatorChar)) { Get-Item -LiteralPath $name }
    }
}
function Test-Path {
    param($LiteralPath)
    if ($script:files.ContainsKey($LiteralPath)) { return $true }
    foreach ($name in $script:files.Keys) {
        if ($name.StartsWith($LiteralPath + [IO.Path]::DirectorySeparatorChar)) { return $true }
    }
    return $false
}
function New-Item { param($ItemType, [switch]$Force, $Path) }
function Copy-Item {
    param($Path, $LiteralPath, $Destination, [switch]$Force)
    if ($LiteralPath) { $Path = $LiteralPath }
    $script:files[$Destination] = $script:files[$Path]
}
function Remove-Item {
    param($Path, [switch]$Recurse, [switch]$Force, $ErrorAction)
    $script:files.Remove($Path)
}
function Get-CompileKeyForFile($FileInfo) { [string]$script:files[$FileInfo.FullName] }
function Convert-Mp3ToWav {
    param($Source, $Destination)
    if ($script:conversionFailure) { throw 'Mock MP3 conversion failure' }
    $script:conversions++
    $script:files[$Destination] = $script:files[$Source] + 100
}
function Run-Staging {
    $script:CurrentFiles = @{}
    $script:FilesToCompile = New-Object System.Collections.Generic.List[string]
    $script:SourceFiles = @(Get-ChildItem -LiteralPath $ModSourcePath -Recurse -File)
    . $stageBlock
    . $cleanupBlock
    $script:lastQueue = @($FilesToCompile)
}
$BuildCache = @{}
$Force = $false
$mp3 = Join-Path $ModSourcePath 'sounds/mods/alert.MP3'
$wav = Join-Path $TempContent 'sounds/mods/alert.wav'
$compiled = Join-Path $TempGame 'sounds/mods/alert.vsnd_c'
$events = Join-Path $ModSourcePath 'soundevents/custom.vsndevts'
$script:files[$mp3] = 10
$script:files[$events] = 20
Run-Staging
Assert-True ($script:conversions -eq 1 -and $script:lastQueue -contains $wav) 'MP3 did not queue a generated WAV'
Assert-True ($script:lastQueue -contains (Join-Path $TempContent 'soundevents/custom.vsndevts')) 'Sound events stopped compiling'
Assert-True (-not $script:files.ContainsKey((Join-Path $TempContent 'sounds/mods/alert.mp3'))) 'Raw MP3 copied into content staging'
Assert-True ($script:files[$mp3] -eq 10) 'Source MP3 modified'
$script:files[$compiled] = 30
$script:files[(Join-Path $TempGame 'soundevents/custom.vsndevts_c')] = 40
Run-Staging
Assert-True ($script:conversions -eq 1 -and $script:lastQueue.Count -eq 0 -and $script:files.ContainsKey($wav) -and $script:files.ContainsKey($compiled)) 'Unchanged MP3 rebuilt or generated sound was deleted'
$script:files[$mp3] = 11
Run-Staging
Assert-True ($script:conversions -eq 2 -and $script:lastQueue -contains $wav -and $script:files[$wav] -eq 111) 'Changed MP3 did not reconvert'
$script:files.Remove($wav)
Run-Staging
Assert-True ($script:conversions -eq 3 -and $script:lastQueue -contains $wav) 'Missing WAV not restored'
$script:files.Remove($compiled)
Run-Staging
Assert-True ($script:conversions -eq 3 -and $script:lastQueue -contains $wav) 'Missing compiled sound did not queue existing WAV'
$Force = $true
Run-Staging
Assert-True ($script:conversions -eq 4 -and $script:lastQueue -contains $wav) 'Force build did not reconvert MP3'
$Force = $false
$sourceWav = [IO.Path]::ChangeExtension($mp3, '.wav')
$script:files[$sourceWav] = 50
$rejected = $false
try { Run-Staging } catch { $rejected = $_.ToString().Contains('Conflicting sound inputs') }
Assert-True ($rejected -and $script:conversions -eq 4 -and $script:files[$mp3] -eq 11 -and $script:files[$sourceWav] -eq 50) 'Same-name MP3/WAV inputs accepted or modified'
$script:files.Remove($sourceWav)
$mp3CacheKey = ($SelectedMod + '|' + $mp3.Substring($ModSourcePath.Length + 1)).ToLower()
$oldKey = $BuildCache[$mp3CacheKey]
Assert-True ($oldKey -eq '11') 'MP3 cache key missing before failure test'
$script:conversionFailure = $true
$script:files[$mp3] = 12
$rejected = $false
try { Run-Staging } catch { $rejected = $_.ToString().Contains('Mock MP3 conversion failure') }
Assert-True ($rejected -and $BuildCache[$mp3CacheKey] -eq $oldKey) 'Conversion failure updated cache or was ignored'
$script:conversionFailure = $false
$script:files.Remove($mp3)
$script:files[$compiled] = 30
Run-Staging
Assert-True (-not $script:files.ContainsKey($wav) -and -not $script:files.ContainsKey($compiled)) 'Deleted MP3 left a generated WAV or compiled sound'

# UI-Mods also compiles releases through a separate loop. Exercise just its
# conversion block with the same mock files, without staging or compiling mods.
$ciPath = Join-Path (Split-Path $BuilderPath) 'build_ci_release.ps1'
if ([IO.File]::Exists($ciPath)) {
    $ciSource = [IO.File]::ReadAllText($ciPath)
    $ciAst = [Management.Automation.Language.Parser]::ParseInput($ciSource, [ref]$tokens, [ref]$errors)
    if ($errors.Count) { throw ($errors | Out-String) }
    $ciLoop = $ciAst.Find({ param($node)
        $node -is [Management.Automation.Language.ForEachStatementAst] -and $node.Variable.VariablePath.UserPath -eq 'Mp3'
    }, $true)
    Assert-True ($null -ne $ciLoop) 'Release builder does not convert MP3 inputs'
    $ciConversion = [scriptblock]::Create($ciLoop.Extent.Text)
    $Content = Join-Path ([IO.Path]::GetTempPath()) 'ci mp3 content'
    $ciMp3 = Join-Path $Content 'sounds/mods/release.mp3'
    $ciWav = [IO.Path]::ChangeExtension($ciMp3, '.wav')
    $script:files[$ciMp3] = 20
    . $ciConversion
    Assert-True ($script:files[$ciWav] -eq 120 -and $script:files[$ciMp3] -eq 20) 'Release MP3 did not produce a WAV or source was modified'
    $rejected = $false
    try { . $ciConversion } catch { $rejected = $_.ToString().Contains('Conflicting sound inputs') }
    Assert-True ($rejected -and $script:files[$ciWav] -eq 120) 'Release builder overwrote a conflicting WAV'
}
'PASS: MP3 conversion errors, incremental reuse, changed/missing/forced sounds, collisions, source preservation and deletion (in-memory files; no compiler or VPK writes)'
