param(
    [Parameter(Mandatory = $true)][string]$Mod,
    [string]$CsdkRoot = 'C:\Reduced_CSDK_12',
    [string]$Output = 'builds'
)
$ErrorActionPreference = 'Stop'
$Output = [System.IO.Path]::GetFullPath($Output)
$Staging = Join-Path ([System.IO.Path]::GetTempPath()) ('ui-mod-release-' + [guid]::NewGuid().ToString('N'))
python tools/mod_releases.py stage --mod $Mod --output $Staging
if ($LASTEXITCODE -ne 0) { throw 'Release source staging failed' }
if (-not (Test-Path -LiteralPath "$CsdkRoot\game\bin_cs2\win64\resourcecompiler.exe")) {
    $CsdkRoot = Join-Path $CsdkRoot 'Reduced_CSDK_12'
}
$Compiler = Join-Path $CsdkRoot 'game\bin_cs2\win64\resourcecompiler.exe'
if (-not (Test-Path -LiteralPath $Compiler)) { throw 'CSDK resource compiler not found' }
New-Item -ItemType Directory -Force -Path $Output | Out-Null
$Outputs = @{
    '.css' = '.vcss_c'; '.xml' = '.vxml_c'; '.js' = '.vjs_c'; '.svg' = '.vsvg_c'; '.vsvg' = '.vsvg_c'
    '.vtex' = '.vtex_c'; '.vsndevts' = '.vsndevts_c'; '.wav' = '.vsnd_c'; '.vpcf' = '.vpcf_c'
    '.vmdl' = '.vmdl_c'; '.vmat' = '.vmat_c'
}
foreach ($Item in (Get-Content -LiteralPath (Join-Path $Staging 'build-plan.json') -Raw | ConvertFrom-Json)) {
    $Addon = 'build_' + [guid]::NewGuid().ToString('N')
    $Content = Join-Path $CsdkRoot "content\citadel_addons\$Addon"
    $Game = Join-Path $CsdkRoot "game\citadel_addons\$Addon"
    New-Item -ItemType Directory -Path $Content | Out-Null
    Get-ChildItem -LiteralPath $Item.content -Directory | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $Content -Recurse
    }
    python tools/prepare_ci_assets.py --content $Content --game $Game
    if ($LASTEXITCODE -ne 0) { throw "Asset preparation failed: $($Item.name)" }
    $Files = Get-ChildItem -LiteralPath $Content -Recurse -File | Where-Object { $_.Extension -in $Outputs.Keys }
    foreach ($File in $Files) {
        & $Compiler -i $File.FullName -nop4
        if ($LASTEXITCODE -ne 0) { throw "Compilation failed: $($File.FullName)" }
        $Relative = $File.FullName.Substring($Content.Length + 1)
        $Compiled = Join-Path $Game ([System.IO.Path]::ChangeExtension($Relative, $Outputs[$File.Extension]))
        if (-not (Test-Path -LiteralPath $Compiled) -or (Get-Item -LiteralPath $Compiled).Length -eq 0) {
            throw "Compiled resource missing: $Compiled"
        }
    }
    $Vpk = Join-Path $Output "$($Item.name).vpk"
    python tools/pack_ci_vpk.py $Game $Vpk
    if ($LASTEXITCODE -ne 0) { throw "Package verification failed: $($Item.name)" }
    Compress-Archive -LiteralPath $Vpk -DestinationPath (Join-Path $Output "$($Item.name).zip")
}
