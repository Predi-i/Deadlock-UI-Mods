param([string]$BuilderPath = (Join-Path $PSScriptRoot '../build_mod.ps1'))
$ErrorActionPreference = 'Stop'
$BuilderPath = (Resolve-Path -LiteralPath $BuilderPath).Path
$source = [IO.File]::ReadAllText($BuilderPath)
$tokens = $null
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($BuilderPath, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
. (Join-Path (Split-Path $BuilderPath) 'build_mod_helpers.ps1')

function Assert-True($Condition, $Message) {
    if (-not $Condition) { throw $Message }
}
foreach ($name in @('Parse-RunFlags', 'Get-CompiledOutputPath', 'Get-AutoVtexBody')) {
    $function = $ast.Find({ param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name
    }.GetNewClosure(), $true)
    . ([scriptblock]::Create($function.Extent.Text))
}
foreach ($flag in @('-Force', '--force', '-f', '--f', 'f')) {
    $result = Parse-RunFlags "2 $flag"
    Assert-True ($result.Force -and $result.Command -eq '2') "Menu flag failed: $flag"
}
$prefix = $source.Substring(0, $source.IndexOf('if (-not $Batch)'))
$argumentParser = [scriptblock]::Create($prefix + "`n[pscustomobject]@{ Force = `$Force; Name = `$ModFolderName }")
$result = & $argumentParser 'Sample' '--force'
Assert-True ($result.Force -and $result.Name -eq 'Sample') 'Launch force flag failed'
$result = & $argumentParser '--force'
Assert-True ($result.Force -and -not $result.Name) 'Standalone launch force flag failed'
$rejected = $false
try { & $argumentParser 'Sample' '--unknown' } catch { $rejected = $true }
Assert-True $rejected 'Unknown argument accepted'
Assert-True ((Get-AutoVtexBody 'panorama/images/example.png').Contains('panorama/images/example.png')) 'Texture descriptor missing input'
Assert-True ($source.IndexOf('if ($errorCount -gt 0)') -lt $source.IndexOf('$CacheObj =')) 'Cache saved before compiler errors checked'
Assert-True ($source.Contains("`$DirectExts = @('.ttf') + `$StaleCompiledExts")) 'Direct resources not classified'
Assert-True (-not $source.Contains("@('.html', '.htm', '.json', '.txt'")) 'Unverified raw formats still included'

# Run only the descriptor requeue block, using fake directory entries.
$start = $source.IndexOf('        if ($imagesChanged) {')
$end = $source.IndexOf('        if ($unsupportedFiles.Count', $start)
$queue = [scriptblock]::Create($source.Substring($start, $end - $start))
function Get-ChildItem { [pscustomobject]@{ FullName = 'custom.vtex' } }
$TempContent = 'unused'
$FilesToCompile = New-Object System.Collections.Generic.List[string]
$imagesChanged = $true
. $queue
. $queue
Assert-True ($FilesToCompile.Count -eq 1 -and $FilesToCompile[0] -eq 'custom.vtex') 'Changed images must requeue custom textures once'
$FilesToCompile.Clear()
$imagesChanged = $false
. $queue
Assert-True ($FilesToCompile.Count -eq 0) 'Unchanged images requeued textures'

# Filesystem operations below are in-memory mocks: no VPKs are created or changed.
$root = Join-Path ([IO.Path]::GetTempPath()) 'compiler-regression'
$stage = Join-Path $root '.build-test'
function Reset-Files {
    $script:files = @{}
    $script:failMove = ''
    $script:failRollback = $false
    $script:moves = New-Object System.Collections.Generic.List[string]
}
function Add-File($Directory, $Name, $Length) {
    $script:files[(Join-Path $Directory $Name)] = $Length
}
function Test-Path {
    param($LiteralPath, $PathType)
    return $script:files.ContainsKey($LiteralPath)
}
function Get-Item {
    param($LiteralPath)
    if (-not $script:files.ContainsKey($LiteralPath)) { throw 'Missing mock file' }
    [pscustomobject]@{ FullName = $LiteralPath; Name = (Split-Path $LiteralPath -Leaf); Extension = [IO.Path]::GetExtension($LiteralPath); Length = $script:files[$LiteralPath] }
}
function Get-ChildItem {
    param($LiteralPath, [switch]$File, $ErrorAction)
    foreach ($path in @($script:files.Keys)) {
        if ((Split-Path $path) -eq $LiteralPath) { Get-Item -LiteralPath $path }
    }
}
function New-Item { param($ItemType, $Path, $ErrorAction) }
function Copy-Item {
    param($LiteralPath, $Destination, [switch]$Force)
    $script:files[$Destination] = $script:files[$LiteralPath]
    $script:copies++
}
function Move-Item {
    param($LiteralPath, $Destination, $ErrorAction)
    if ($LiteralPath -eq $script:failMove) {
        $script:failMove = ''
        throw 'Mock move failure'
    }
    if ($script:failRollback -and (Split-Path $LiteralPath -Leaf) -eq 'pak01_dir.vpk' -and $LiteralPath.Contains('previous')) {
        throw 'Mock rollback failure'
    }
    if (-not $script:files.ContainsKey($LiteralPath)) { throw 'Moving nonexistent mock file' }
    $script:files[$Destination] = $script:files[$LiteralPath]
    $script:files.Remove($LiteralPath)
    $script:moves.Add($Destination)
}
function Remove-Item {
    param($LiteralPath, [switch]$Recurse, [switch]$Force, $ErrorAction)
    foreach ($path in @($script:files.Keys)) {
        if ($path -eq $LiteralPath -or ($Recurse -and $path.StartsWith($LiteralPath + [IO.Path]::DirectorySeparatorChar))) {
            $script:files.Remove($path)
        }
    }
}

Reset-Files
$script:copies = 0
$TempGame = $stage
$DirectExts = @('.ttf', '.vtex_c')
$start = $source.IndexOf('            if ($DirectExts -contains $file.Extension) {')
$end = $source.IndexOf('            if ($AutoVtexSourceExts', $start)
$rawStaging = [scriptblock]::Create($source.Substring($start, $end - $start))
foreach ($name in @('Mojang-Regular.ttf', 'texture.vtex_c')) {
    Add-File $root $name 100
    $file = Get-Item -LiteralPath (Join-Path $root $name)
    $relPath = 'panorama/' + $name
    $hashChanged = $false
    . $rawStaging
    Assert-True ($script:files[(Join-Path $TempGame $relPath)] -eq 100) 'Direct resource missing'
    $oldCopies = $script:copies
    . $rawStaging
    Assert-True ($script:copies -eq $oldCopies) 'Unchanged direct resource copied again'
    $script:files[$file.FullName] = 200
    $hashChanged = $true
    . $rawStaging
    Assert-True ($script:files[(Join-Path $TempGame $relPath)] -eq 200) 'Direct resource not updated'
    $script:files.Remove((Join-Path $TempGame $relPath))
    $hashChanged = $false
    . $rawStaging
    Assert-True ($script:files[(Join-Path $TempGame $relPath)] -eq 200) 'Direct resource not restored'
}

Reset-Files
Add-File $root 'pak01_dir.vpk' 100
Add-File $root 'pak01_000.vpk' 200
Add-File $root 'pak01_001.vpk' 300
Add-File $root 'pak02_dir.vpk' 400
Add-File $stage 'pak01_dir.vpk' 500
Add-File $stage 'pak01_000.vpk' 600
Publish-VpkBundle -Staging $stage -Output (Join-Path $root 'pak01_dir.vpk')
Assert-True ($script:files[(Join-Path $root 'pak01_dir.vpk')] -eq 500) 'New index not installed'
Assert-True (-not $script:files.ContainsKey((Join-Path $root 'pak01_001.vpk'))) 'Stale shard kept'
Assert-True ($script:files[(Join-Path $root 'pak02_dir.vpk')] -eq 400) 'Unrelated mod changed'
Assert-True ($script:moves[$script:moves.Count - 1] -eq (Join-Path $root 'pak01_dir.vpk')) 'Index not installed last'

Reset-Files
Add-File $root 'pak01_dir.vpk' 100
Add-File $root 'pak01_000.vpk' 200
Add-File $stage 'pak01_dir.vpk' 500
Add-File $stage 'pak01_000.vpk' 600
$script:failMove = Join-Path $stage 'pak01_dir.vpk'
$rejected = $false
try { Publish-VpkBundle -Staging $stage -Output (Join-Path $root 'pak01_dir.vpk') } catch { $rejected = $true }
Assert-True $rejected 'Move failure not reported'
Assert-True ($script:files[(Join-Path $root 'pak01_dir.vpk')] -eq 100) 'Old index not restored'
Assert-True ($script:files[(Join-Path $root 'pak01_000.vpk')] -eq 200) 'Old shard not restored'

Reset-Files
Add-File $root 'pak01_dir.vpk' 100
Add-File $stage 'pak01_dir.vpk' 0
$rejected = $false
try { Publish-VpkBundle -Staging $stage -Output (Join-Path $root 'pak01_dir.vpk') } catch { $rejected = $true }
Assert-True ($rejected -and $script:files[(Join-Path $root 'pak01_dir.vpk')] -eq 100 -and $script:moves.Count -eq 0) 'Invalid output touched old build'

Reset-Files
Add-File $root 'pak01_dir.vpk' 100
Add-File $stage 'pak01_dir.vpk' 500
$script:failMove = Join-Path $stage 'pak01_dir.vpk'
$script:failRollback = $true
$message = ''
try { Publish-VpkBundle -Staging $stage -Output (Join-Path $root 'pak01_dir.vpk') } catch { $message = $_.ToString() }
Assert-True ($message.Contains('rollback failed') -and $script:files[(Join-Path $stage 'previous/pak01_dir.vpk')] -eq 100) 'Failed rollback lost backup'
$rejected = $false
try { Assert-BuildChildPath -Path (Join-Path $root '../outside') -Parent $root } catch { $rejected = $true }
Assert-True $rejected 'Escaping path accepted'
Reset-Files
Assert-True ((Get-NextPakName $root) -eq 'pak01_dir.vpk') 'Empty addons did not start at pak01'
Add-File $root 'pak99_dir.vpk' 100
Add-File $root 'pak101_dir.vpk' 100
Assert-True ((Get-NextPakName $root) -eq 'pak01_dir.vpk') 'High addon numbers forced allocation past 99'
Add-File $root 'pak01_dir.vpk' 100
Add-File $root 'pak03_dir.vpk' 100
Assert-True ((Get-NextPakName $root) -eq 'pak02_dir.vpk') 'Gap not reused'
Add-File $root 'pak02_000.vpk' 100
Assert-True ((Get-NextPakName $root) -eq 'pak04_dir.vpk') 'Orphan shard overwritten'
for ($number = 1; $number -le 99; $number++) { Add-File $root ('pak{0:D2}_dir.vpk' -f $number) 100 }
$rejected = $false
try { Get-NextPakName $root } catch { $rejected = $_.ToString().Contains('All addon slots') }
Assert-True $rejected 'Full addon directory allocated pak100'
'PASS: flags, textures, direct resources, cache ordering, VPK replacement/rollback, path guards, addon allocation (no compiler or VPK filesystem writes)'
