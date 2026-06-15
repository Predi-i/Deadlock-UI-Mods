[CmdletBinding()]
param(
    [string]$ModFolderName,
    [switch]$Force,
    [switch]$CleanTemp
)

[console]::TreatControlCAsInput = $false
$ErrorActionPreference = "Stop"
$Host.UI.RawUI.WindowTitle = "Deadlock Mod Compiler"

$ScriptDir = (Resolve-Path "$PSScriptRoot").Path
$RepoRoot = (Resolve-Path "$ScriptDir\..").Path

$DataDir = Join-Path $ScriptDir "data"
if (-not (Test-Path $DataDir)) { New-Item -ItemType Directory -Force -Path $DataDir | Out-Null }

$BuildsDir = Join-Path $ScriptDir "builds"
$RegistryPath = Join-Path $DataDir "mod_registry.json"
$ConfigPath = Join-Path $DataDir "config.json"
$CachePath = Join-Path $DataDir "build_cache.json"

# ==============================================================================
# HELPER FUNCTIONS
# ==============================================================================
function Wait-KeyPressAndExit {
    Write-Host "`nPress ANY KEY to exit..." -ForegroundColor Cyan
    $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
    exit 1
}

function Get-ModRegistry {
    if (Test-Path $RegistryPath) {
        try {
            $jsonObj = Get-Content $RegistryPath -Raw | ConvertFrom-Json
            $hash = @{}
            $jsonObj.psobject.properties | ForEach-Object { $hash[$_.Name] = $_.Value }
            return $hash
        } catch { return @{} }
    }
    return @{}
}

function Save-ModRegistry ($RegistryMap) {
    $RegistryMap | ConvertTo-Json -Depth 2 | Set-Content $RegistryPath -Encoding UTF8
}

function Get-NextPakName ($TargetDir, $RegistryMap) {
    $maxNum = 0
    $existingPaks = Get-ChildItem -Path $TargetDir -Filter "pak*_dir.vpk" -File -ErrorAction SilentlyContinue
    foreach ($pak in $existingPaks) {
        if ($pak.Name -match "^pak(\d+)_dir\.vpk$") {
            $num = [int]$matches[1]
            if ($num -gt $maxNum) { $maxNum = $num }
        }
    }
    if ($RegistryMap -and $RegistryMap.Count -gt 0) {
        foreach ($val in $RegistryMap.Values) {
            if ($val -match "^pak(\d+)_dir\.vpk$") {
                $num = [int]$matches[1]
                if ($num -gt $maxNum) { $maxNum = $num }
            }
        }
    }
    return "pak{0:D2}_dir.vpk" -f ($maxNum + 1)
}

function Kill-Deadlock {
    $process = Get-Process -Name "project8" -ErrorAction SilentlyContinue
    if (-not $process) { $process = Get-Process -Name "deadlock" -ErrorAction SilentlyContinue }
    if ($process) {
        Write-Host "Closing Deadlock..." -ForegroundColor Yellow
        Stop-Process -InputObject $process -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 3 
    }
}

function Start-Deadlock {
    Write-Host "Starting Deadlock..." -ForegroundColor Cyan
    Start-Process "steam://run/1422450"
}

function Get-CompileKeyForFile($FileInfo) {
    $hash = (Get-FileHash -Path $FileInfo.FullName -Algorithm MD5).Hash
    return "{0}|{1}|{2}" -f $hash, $FileInfo.Length, $FileInfo.LastWriteTimeUtc.Ticks
}

# ==============================================================================
# CONFIGURATION MANAGEMENT
# ==============================================================================
$DefaultConfig = [ordered]@{
    BuildDestination = "Ask"
    ExecutionMode    = "BuildOnly"
    SteamPath        = ""
    CsdkPath         = "C:\Reduced_CSDK_12"
}

if (-not (Test-Path $ConfigPath)) {
    $DefaultConfig | ConvertTo-Json -Depth 2 | Set-Content $ConfigPath -Encoding UTF8
    $Config = $DefaultConfig
    Write-Host "Created default config.json" -ForegroundColor DarkGray
} else {
    try {
        $Config = Get-Content $ConfigPath -Raw | ConvertFrom-Json
        $configUpdated = $false
        foreach ($key in $DefaultConfig.Keys) {
            if ($null -eq $Config.$key) {
                $Config | Add-Member -MemberType NoteProperty -Name $key -Value $DefaultConfig[$key]
                $configUpdated = $true
            }
        }
        if ($configUpdated) { $Config | ConvertTo-Json -Depth 2 | Set-Content $ConfigPath -Encoding UTF8 }
    } catch {
        Write-Host "ERROR: config.json is corrupted. Using defaults." -ForegroundColor Red
        $Config = $DefaultConfig
    }
}

# ==============================================================================
# PATH RESOLUTION
# ==============================================================================
$SteamPath = $Config.SteamPath
if ([string]::IsNullOrWhiteSpace($SteamPath) -or -not (Test-Path $SteamPath)) {
    $SteamPath = "C:\Program Files (x86)\Steam"
    try {
        $RegSteam = Get-ItemPropertyValue -Path "HKLM:\SOFTWARE\WOW6432Node\Valve\Steam" -Name "InstallPath" -ErrorAction Stop
        if (Test-Path $RegSteam) { $SteamPath = $RegSteam }
    } catch { }
}

$PotentialLibs = @($SteamPath)
$VdfPath = Join-Path $SteamPath "steamapps\libraryfolders.vdf"
if (Test-Path $VdfPath) {
    $VdfContent = Get-Content $VdfPath -Raw
    $Matches = [regex]::Matches($VdfContent, '"path"\s+"([^"]+)"')
    foreach ($m in $Matches) {
        $PotentialLibs += $m.Groups[1].Value.Replace("\\", "\")
    }
}

$AddonsDir = $null
foreach ($lib in $PotentialLibs) {
    $DeadlockBase = Join-Path $lib "steamapps\common\Deadlock"
    if (Test-Path $DeadlockBase) {
        $AddonsDir = Join-Path $DeadlockBase "game\citadel\addons"
        if (-not (Test-Path $AddonsDir)) { New-Item -ItemType Directory -Force -Path $AddonsDir | Out-Null }
        break
    }
}

if ($null -eq $AddonsDir) {
    $AddonsDir = Join-Path $SteamPath "steamapps\common\Deadlock\game\citadel\addons"
}

$CsdkRoot = $Config.CsdkPath
if (-not (Test-Path (Join-Path $CsdkRoot "game\bin_cs2\win64\resourcecompiler.exe"))) {
    $NestedRoot = Join-Path $CsdkRoot "Reduced_CSDK_12"
    if (Test-Path (Join-Path $NestedRoot "game\bin_cs2\win64\resourcecompiler.exe")) {
        $CsdkRoot = $NestedRoot
    } else {
        Write-Host "ERROR: CSDK not found at $CsdkRoot." -ForegroundColor Red
        Write-Host "Please set the correct path in config.json." -ForegroundColor Yellow
        Wait-KeyPressAndExit
    }
}

$Compiler = Join-Path $CsdkRoot "game\bin_cs2\win64\resourcecompiler.exe"
$Packer   = Join-Path $CsdkRoot "game\bin\win64\CSDKCfgVPK.exe"

# ==============================================================================
# MAIN LOOP
# ==============================================================================
$InitialMod = $ModFolderName

while ($true) {
    Clear-Host
    Write-Host "=== Deadlock Mod Compiler (Incremental Build) ===" -ForegroundColor Cyan
    Write-Host "Tip: use -Force for a full rebuild, -CleanTemp to wipe temporary build folders.`n" -ForegroundColor DarkGray
    
    $SelectedMod = $InitialMod

    if ([string]::IsNullOrWhiteSpace($SelectedMod)) {
        Write-Host "Available mods to build:" -ForegroundColor White
        
        $folders = Get-ChildItem -Path $RepoRoot -Directory | Where-Object { 
            $_.Name -notmatch "^\." -and 
            $_.Name -notin @("tools", "builds") 
        }

        if ($folders.Count -eq 0) {
            Write-Host "ERROR: No valid mod folders found in $RepoRoot." -ForegroundColor Red
            Wait-KeyPressAndExit
        }

        for ($i = 0; $i -lt $folders.Count; $i++) {
            Write-Host "[$i] $($folders[$i].Name)"
        }

        $validSelection = $false
        while (-not $validSelection) {
            $selection = Read-Host "Enter the number of the mod to compile"
            if ([int]::TryParse($selection, [ref]$null) -and [int]$selection -ge 0 -and [int]$selection -lt $folders.Count) {
                $SelectedMod = $folders[[int]$selection].Name
                $validSelection = $true
            }
        }
    }

    $InitialMod = $null
    $ModSourcePath = Join-Path $RepoRoot $SelectedMod

    if (-not (Test-Path $ModSourcePath)) {
        Write-Host "ERROR: Mod folder '$SelectedMod' not found." -ForegroundColor Red
        Wait-KeyPressAndExit
    }

    $BuildMode = 0
    if ($Config.ExecutionMode -eq "BuildAndRestart") {
        $BuildMode = 2
    } else {
        if ($Config.BuildDestination -eq "Builds") { $BuildMode = 1 } 
        elseif ($Config.BuildDestination -eq "Addons") { $BuildMode = 2 } 
        else {
            Write-Host "`nSelect build destination:" -ForegroundColor Cyan
            Write-Host "[1] Local (/tools/builds/$SelectedMod.vpk)"
            Write-Host "[2] Game Addons Folder ($AddonsDir)"
            while ($BuildMode -notin @(1, 2)) {
                $modeSelection = Read-Host "Enter 1 or 2"
                if ([int]::TryParse($modeSelection, [ref]$null)) { $BuildMode = [int]$modeSelection }
            }
        }
    }

    $OutputVpk = ""
    if ($BuildMode -eq 1) {
        if (Test-Path $BuildsDir -PathType Leaf) { Remove-Item $BuildsDir -Force }
        if (-not (Test-Path $BuildsDir)) { New-Item -ItemType Directory -Force -Path $BuildsDir | Out-Null }
        $OutputVpk = Join-Path $BuildsDir "$SelectedMod.vpk"
    } else {
        if (-not (Test-Path $AddonsDir)) {
            Write-Host "ERROR: Addons directory not found: $AddonsDir" -ForegroundColor Red
            $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
            continue
        }
        $Registry = Get-ModRegistry
        $AssignedPak = $Registry[$SelectedMod]
        if ($AssignedPak -and (Test-Path (Join-Path $AddonsDir $AssignedPak))) {
            $OutputVpk = Join-Path $AddonsDir $AssignedPak
        } else {
            $AssignedPak = Get-NextPakName -TargetDir $AddonsDir -RegistryMap $Registry
            $Registry[$SelectedMod] = $AssignedPak
            Save-ModRegistry -RegistryMap $Registry
            $OutputVpk = Join-Path $AddonsDir $AssignedPak
        }
    }

    Write-Host "`n=== Starting build process for: $SelectedMod ===" -ForegroundColor Green
    Write-Host "Destination: $OutputVpk" -ForegroundColor DarkGray

    $TempContent = Join-Path $CsdkRoot "content\citadel_addons\build_$SelectedMod"
    $TempGame    = Join-Path $CsdkRoot "game\citadel_addons\build_$SelectedMod"

    try {
        if ($Config.ExecutionMode -eq "BuildAndRestart") { Kill-Deadlock }

        if ($CleanTemp) {
            Write-Host "Cleaning temp build folders..." -ForegroundColor Yellow
            if (Test-Path $TempContent) { Remove-Item -Path $TempContent -Recurse -Force }
            if (Test-Path $TempGame) { Remove-Item -Path $TempGame -Recurse -Force }
        }

        $BuildCache = @{}
        if (Test-Path $CachePath) {
            try {
                $json = Get-Content $CachePath -Raw | ConvertFrom-Json
                $json.psobject.properties | ForEach-Object { $BuildCache[$_.Name] = $_.Value }
            } catch {}
        }

        if (-not (Test-Path $TempContent)) { New-Item -ItemType Directory -Force -Path $TempContent | Out-Null }
        if (-not (Test-Path $TempGame)) { New-Item -ItemType Directory -Force -Path $TempGame | Out-Null }

        Write-Host "Step 1/3: Checking for modified files (Hashing)..." -ForegroundColor Cyan
        if ($Force) {
            Write-Host "  Force rebuild enabled for this run." -ForegroundColor Yellow
        }
        
        $SourceFiles = Get-ChildItem -Path $ModSourcePath -Recurse -File
        $CurrentFiles = @{}
        $FilesToCompile = New-Object System.Collections.Generic.List[string]
        
        $Utf8NoBom = New-Object System.Text.UTF8Encoding $false
        $AllowedExts = @('.xml', '.css', '.js', '.vsndevts', '.wav', '.vtex', '.vsvg', '.vpcf', '.vmdl', '.vmat')
        
        $updatedCount = 0

        foreach ($file in $SourceFiles) {
            $relPath = $file.FullName.Substring($ModSourcePath.Length + 1)
            $cacheKey = "${SelectedMod}|${relPath}".ToLower()
            $CurrentFiles[$cacheKey] = $true

            $compileKey = Get-CompileKeyForFile -FileInfo $file
            $contentDest = Join-Path $TempContent $relPath

            $needsUpdate = $Force
            if (-not $needsUpdate) {
                if (-not $BuildCache.Contains($cacheKey) -or $BuildCache[$cacheKey] -ne $compileKey -or -not (Test-Path $contentDest)) {
                    $needsUpdate = $true
                }
            }

            if ($needsUpdate) {
                $dir = Split-Path $contentDest
                if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }

                Copy-Item -Path $file.FullName -Destination $contentDest -Force

                if ($file.Extension -eq '.vtex') {
                    $content = [System.IO.File]::ReadAllText($contentDest)
                    if ($content -match '"m_algorithm"\s+"string"') {
                        $content = $content -replace '("m_algorithm"\s+"string"\s+)"[^"]+"', '$1""'
                        [System.IO.File]::WriteAllText($contentDest, $content, $Utf8NoBom)
                    }
                }

                if ($AllowedExts -contains $file.Extension) {
                    $FilesToCompile.Add($contentDest)
                }

                $BuildCache[$cacheKey] = $compileKey
                $updatedCount++
            }
        }

        $KeysToRemove = New-Object System.Collections.Generic.List[string]
        $prefix = "${SelectedMod}|".ToLower()
        foreach ($key in $BuildCache.Keys) {
            if ($key.StartsWith($prefix)) {
                if (-not $CurrentFiles.Contains($key)) {
                    $KeysToRemove.Add($key)
                    $relPath = $key.Substring($prefix.Length)
                    
                    $cPath = Join-Path $TempContent $relPath
                    if (Test-Path $cPath) { Remove-Item $cPath -Force }

                    $gPath = Join-Path $TempGame $relPath
                    $gPathC = $gPath + "_c"
                    if (Test-Path $gPath) { Remove-Item $gPath -Force }
                    if (Test-Path $gPathC) { Remove-Item $gPathC -Force }
                }
            }
        }
        foreach ($k in $KeysToRemove) { $BuildCache.Remove($k) }

        Write-Host "  Found $updatedCount new/modified files. Removed $($KeysToRemove.Count) deleted files." -ForegroundColor DarkGray

        if ($updatedCount -gt 0) {
            $pngUpdates = ($SourceFiles | Where-Object { $_.Extension -eq '.png' -and $BuildCache.Contains("${SelectedMod}|$($_.FullName.Substring($ModSourcePath.Length + 1))".ToLower()) }).Count
            if ($pngUpdates -gt 0) {
                Write-Host "  PNG source changes are tracked via hash + file size + timestamp." -ForegroundColor DarkGray
            }
        }

        $CacheObj = New-Object PSObject
        foreach ($key in $BuildCache.Keys) {
            $CacheObj | Add-Member -MemberType NoteProperty -Name $key -Value $BuildCache[$key]
        }
        $CacheObj | ConvertTo-Json -Depth 1 | Set-Content $CachePath -Encoding UTF8

        Write-Host "Step 2/3: Compiling assets..." -ForegroundColor Cyan
        $errorCount = 0
        $totalFiles = $FilesToCompile.Count

        if ($totalFiles -gt 0) {
            $batchSize = 25
            $batches = [math]::Ceiling($totalFiles / $batchSize)
            
            for ($i = 0; $i -lt $batches; $i++) {
                $batchFiles = $FilesToCompile | Select-Object -Skip ($i * $batchSize) -First $batchSize
                $statusText = "  Compiling batch $($i + 1)/$batches ($($batchFiles.Count) files)..."
                $padLength = [math]::Max(0, 80 - $statusText.Length)
                Write-Host "`r$statusText$($(" " * $padLength))" -NoNewline -ForegroundColor Yellow

                $compilerArgs = @()
                foreach ($file in $batchFiles) {
                    $compilerArgs += "-i"
                    $compilerArgs += $file
                }
                $compilerArgs += "-nop4"
                
                $CompileOutput = & $Compiler @compilerArgs 2>&1
                
                if ($LASTEXITCODE -ne 0) {
                    Write-Host "`n  [!] Error compiling batch $($i + 1)" -ForegroundColor Red
                    Write-Host "      Details: $CompileOutput" -ForegroundColor DarkRed
                    $errorCount += $batchFiles.Count
                }
            }
            Write-Host "`n  Done compiling $totalFiles files." -ForegroundColor Green
        } else {
            Write-Host "  No files changed since last build. Skipping compilation." -ForegroundColor Green
        }

        if ($errorCount -gt 0) {
            Write-Host "WARNING: $errorCount files failed to compile. VPK might be incomplete." -ForegroundColor Red
        }

        Write-Host "Step 3/3: Packing VPK..." -ForegroundColor Cyan
        if (Test-Path $OutputVpk) { Remove-Item -Path $OutputVpk -Force }

        $PackerOutput = & $Packer $TempGame $OutputVpk 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Host $PackerOutput -ForegroundColor DarkRed
            throw "VPK Packer failed with exit code $LASTEXITCODE."
        }

        Write-Host "`n=== BUILD SUCCESSFUL ===" -ForegroundColor Green
        Write-Host "Output saved to: $OutputVpk" -ForegroundColor White

        if ($Config.ExecutionMode -eq "BuildAndRestart") { Start-Deadlock }
    }
    catch {
        Write-Host "`n=== BUILD FAILED ===" -ForegroundColor Red
        Write-Host $_.Exception.Message -ForegroundColor Red
    }
    finally {
        Start-Sleep -Milliseconds 500 
    }

    Write-Host "`nPress ANY KEY to return to the main menu, or ESC to exit..." -ForegroundColor Cyan
    $key = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
    if ($key.VirtualKeyCode -eq 27) { break }
}