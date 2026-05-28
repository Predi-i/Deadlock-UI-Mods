[CmdletBinding()]
param([string]$ModFolderName)

[console]::TreatControlCAsInput = $false

$ErrorActionPreference = "Stop"

# ==============================================================================
# Path Settings
# Change the paths below if your Steam or CSDK is installed elsewhere.
# ==============================================================================
$DefaultSteamPath = "C:\Program Files (x86)\Steam"
$DefaultCsdkRoot  = "C:\Reduced_CSDK_12"
# ==============================================================================

$SteamPath = $DefaultSteamPath
try {
    $RegSteam = Get-ItemPropertyValue -Path "HKLM:\SOFTWARE\WOW6432Node\Valve\Steam" -Name "InstallPath" -ErrorAction Stop
    if (Test-Path $RegSteam) { $SteamPath = $RegSteam }
} catch { }

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

$RepoRoot = (Resolve-Path "$PSScriptRoot\..").Path
$BuildsDir = Join-Path $RepoRoot "builds"
$RegistryPath = Join-Path $RepoRoot "mod_registry.json"

$CsdkRoot = $DefaultCsdkRoot
if (-not (Test-Path (Join-Path $CsdkRoot "game\bin_cs2\win64\resourcecompiler.exe"))) {
    $NestedRoot = Join-Path $CsdkRoot "Reduced_CSDK_12"
    if (Test-Path (Join-Path $NestedRoot "game\bin_cs2\win64\resourcecompiler.exe")) {
        $CsdkRoot = $NestedRoot
    } else {
        Write-Host "ERROR: CSDK not found at $CsdkRoot or nested folder." -ForegroundColor Red
        exit 1
    }
}

$Compiler = Join-Path $CsdkRoot "game\bin_cs2\win64\resourcecompiler.exe"
$Packer   = Join-Path $CsdkRoot "game\bin\win64\CSDKCfgVPK.exe"
$TempContent = Join-Path $CsdkRoot "content\citadel_addons\predi_temp_build"
$TempGame    = Join-Path $CsdkRoot "game\citadel_addons\predi_temp_build"

function Get-ModRegistry {
    if (Test-Path $RegistryPath) {
        try {
            $jsonObj = Get-Content $RegistryPath -Raw | ConvertFrom-Json
            $hash = @{}
            $jsonObj.psobject.properties | ForEach-Object { $hash[$_.Name] = $_.Value }
            return $hash
        } catch {
            return @{}
        }
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

$InitialMod = $ModFolderName

while ($true) {
    Clear-Host

    $SelectedMod = $InitialMod

    if ([string]::IsNullOrWhiteSpace($SelectedMod)) {
        Write-Host "Available mods to build:" -ForegroundColor Cyan
        
        $folders = Get-ChildItem -Path $RepoRoot -Directory | Where-Object { 
            $_.Name -notmatch "^\." -and 
            $_.Name -notin @("tools", "builds") 
        }

        if ($folders.Count -eq 0) {
            Write-Host "ERROR: No valid mod folders found." -ForegroundColor Red
            exit 1
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
        exit 1
    }

    Write-Host "`nSelect build destination:" -ForegroundColor Cyan
    Write-Host "[1] Local (/builds/$SelectedMod.vpk)"
    Write-Host "[2] Game Addons Folder ($AddonsDir)"
    
    $BuildMode = 0
    while ($BuildMode -notin @(1, 2)) {
        $modeSelection = Read-Host "Enter 1 or 2"
        if ([int]::TryParse($modeSelection, [ref]$null)) {
            $BuildMode = [int]$modeSelection
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
            Write-Host "Please verify game installation." -ForegroundColor Yellow
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

    try {
        if (Test-Path $TempContent) { Remove-Item -Path $TempContent -Recurse -Force }
        if (Test-Path $TempGame) { Remove-Item -Path $TempGame -Recurse -Force }
        
        New-Item -ItemType Directory -Force -Path $TempContent | Out-Null

        Write-Host "Step 1/3: Copying source files..." -ForegroundColor Cyan
        Copy-Item -Path "$ModSourcePath\*" -Destination $TempContent -Recurse -Force

        $VtexFilesToPatch = Get-ChildItem -Path $TempContent -Recurse -Filter *.vtex
        $Utf8NoBom = New-Object System.Text.UTF8Encoding $false
        
        foreach ($vFile in $VtexFilesToPatch) {
            $content = [System.IO.File]::ReadAllText($vFile.FullName)
            
            if ($content -match '"m_algorithm"\s+"string"') {
                $content = $content -replace '("m_algorithm"\s+"string"\s+)"[^"]+"', '$1""'
                [System.IO.File]::WriteAllText($vFile.FullName, $content, $Utf8NoBom)
            }
        }

        Write-Host "Step 2/3: Compiling assets..." -ForegroundColor Cyan
        
        $AllowedExts = @('.xml', '.css', '.js', '.vsndevts', '.wav', '.vtex', '.vsvg')
        $FilesToCompile = Get-ChildItem -Path $TempContent -Recurse -File | Where-Object { $_.Extension -in $AllowedExts }
        
        $errorCount = 0
        $totalFiles = $FilesToCompile.Count
        $currentIndex = 0

        foreach ($file in $FilesToCompile) {
            $currentIndex++
            
            $statusText = "  Compiling [$currentIndex/$totalFiles]: $($file.Name)"
            $padLength = [math]::Max(0, 80 - $statusText.Length)
            $padding = " " * $padLength
            
            Write-Host "`r$statusText$padding" -NoNewline -ForegroundColor Yellow

            $CompileOutput = & $Compiler -i $file.FullName -nop4 2>&1
            
            if ($LASTEXITCODE -ne 0) {
                Write-Host "`n  [!] Error compiling: $($file.Name)" -ForegroundColor Red
                Write-Host "      Details: $CompileOutput" -ForegroundColor DarkRed
                $errorCount++
            }
        }
        
        if ($totalFiles -gt 0) { Write-Host "`n  Done compiling $totalFiles files." -ForegroundColor Green }

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
    }
    catch {
        Write-Host "`n=== BUILD FAILED ===" -ForegroundColor Red
        Write-Host $_.Exception.Message -ForegroundColor Red
    }
    finally {
        Start-Sleep -Milliseconds 500 
        if (Test-Path $TempContent) { Remove-Item -Path $TempContent -Recurse -Force -ErrorAction SilentlyContinue }
        if (Test-Path $TempGame) { Remove-Item -Path $TempGame -Recurse -Force -ErrorAction SilentlyContinue }
    }

    Write-Host "`nPress ANY KEY to return to the main menu, or ESC to exit..." -ForegroundColor Cyan
    $key = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
    
    if ($key.VirtualKeyCode -eq 27) {
        break
    }
}