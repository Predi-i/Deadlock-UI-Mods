param(
    [string]$ModFolderName
)

$RepoRoot = (Resolve-Path "$PSScriptRoot\..").Path
$BuildsDir = "$RepoRoot\builds"
$BaseCsdkRoot = "C:\Reduced_CSDK_12"
$DoubleCsdkRoot = "C:\Reduced_CSDK_12\Reduced_CSDK_12"

if (Test-Path "$BaseCsdkRoot\game\bin_cs2\win64\resourcecompiler.exe") {
    $CsdkRoot = $BaseCsdkRoot
} elseif (Test-Path "$DoubleCsdkRoot\game\bin_cs2\win64\resourcecompiler.exe") {
    $CsdkRoot = $DoubleCsdkRoot
} else {
    Write-Host "ERROR: CSDK not found at $BaseCsdkRoot" -ForegroundColor Red
    Write-Host "Please download and extract Reduced CSDK 12 to your C:\ drive." -ForegroundColor Yellow
    exit
}

$Compiler = "$CsdkRoot\game\bin_cs2\win64\resourcecompiler.exe"
$Packer = "$CsdkRoot\game\bin\win64\CSDKCfgVPK.exe"
$TempContent = "$CsdkRoot\content\citadel_addons\predi_temp_build"
$TempGame = "$CsdkRoot\game\citadel_addons\predi_temp_build"

if ([string]::IsNullOrWhiteSpace($ModFolderName)) {
    Write-Host "Available mods to build:" -ForegroundColor Cyan
    $folders = Get-ChildItem -Path $RepoRoot -Directory | Where-Object { $_.Name -notmatch "^\." -and $_.Name -ne "tools" -and $_.Name -ne "builds" }
    for ($i=0; $i -lt $folders.Count; $i++) {
        Write-Host "[$i] $($folders[$i].Name)"
    }
    $selection = Read-Host "Enter the number of the mod to compile"
    $ModFolderName = $folders[[int]$selection].Name
}

$ModSourcePath = "$RepoRoot\$ModFolderName"
if (-not (Test-Path $ModSourcePath)) {
    Write-Host "ERROR: Mod folder '$ModFolderName' not found." -ForegroundColor Red
    exit
}

Write-Host "=== Starting build process for: $ModFolderName ===" -ForegroundColor Green

if (Test-Path $TempContent) { Remove-Item -Path $TempContent -Recurse -Force }
if (Test-Path $TempGame) { Remove-Item -Path $TempGame -Recurse -Force }
New-Item -ItemType Directory -Force -Path $TempContent | Out-Null
New-Item -ItemType Directory -Force -Path $BuildsDir | Out-Null

Write-Host "Step 1/3: Copying source files..."
Copy-Item -Path "$ModSourcePath\*" -Destination $TempContent -Recurse -Force

Write-Host "Step 2/3: Compiling assets..."
$FilesToCompile = Get-ChildItem -Path $TempContent -Recurse -File -Include *.xml, *.css, *.js, *.vsndevts, *.wav
foreach ($file in $FilesToCompile) {
    & $Compiler -i $file.FullName -nop4 | Out-Null
}

Write-Host "Step 3/3: Packing VPK..."
$OutputVpk = "$BuildsDir\$ModFolderName.vpk"
if (Test-Path $OutputVpk) { Remove-Item -Path $OutputVpk -Force }

& $Packer $TempGame $OutputVpk | Out-Null

Remove-Item -Path $TempContent -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -Path $TempGame -Recurse -Force -ErrorAction SilentlyContinue

Write-Host "=== BUILD SUCCESSFUL ===" -ForegroundColor Green
Write-Host "Output saved to: $OutputVpk" -ForegroundColor Cyan