[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$DroppedFiles
)

[console]::TreatControlCAsInput = $false
$Host.UI.RawUI.WindowTitle = "Deadlock Texture Tool"

$ScriptDir = (Resolve-Path "$PSScriptRoot").Path
$ConfigPath = Join-Path $ScriptDir "texture_config.json"

function Wait-KeyPressAndExit {
    Write-Host "`nPress ANY KEY to exit..." -ForegroundColor Cyan
    $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
    exit
}

function Generate-VtexFile ($ImagePath) {
    $imgName = [System.IO.Path]::GetFileName($ImagePath)
    $vtexPath = [System.IO.Path]::ChangeExtension($ImagePath, ".vtex")
    
    $normalizedPath = $ImagePath -replace '\\', '/'
    $match = [regex]::Match($normalizedPath, '(?i)(panorama|materials|models|particles|soundevents|sounds)/.*$')
    
    if ($match.Success) {
        $relFileName = $match.Value
    } else {
        $relFileName = $imgName
    }
    
    $vtexContent = @"
<!-- dmx encoding keyvalues2_noids 1 format vtex 1 -->
"CDmeVtex"
{
    "m_inputTextureArray" "element_array"
    [
        "CDmeInputTexture"
        {
            "m_name" "string" "InputTexture0"
            "m_fileName" "string" "$relFileName"
            "m_colorSpace" "string" "srgb"
            "m_typeString" "string" "2D"
            "m_imageProcessorArray" "element_array"
            [
                "CDmeImageProcessor"
                {
                    "m_algorithm" "string" "None"
                    "m_stringArg" "string" ""
                    "m_vFloat4Arg" "vector4" "0 0 0 0"
                }
            ]
        }
    ]
    "m_outputTypeString" "string" "2D"
    "m_outputFormat" "string" "BGRA8888"
    "m_outputClearColor" "vector4" "0 0 0 0"
    "m_nOutputMinDimension" "int" "0"
    "m_nOutputMaxDimension" "int" "0"
    "m_textureOutputChannelArray" "element_array"
    [
        "CDmeTextureOutputChannel"
        {
            "m_inputTextureArray" "string_array" [ "InputTexture0" ]
            "m_srcChannels" "string" "rgba"
            "m_dstChannels" "string" "rgba"
            "m_mipAlgorithm" "CDmeImageProcessor"
            {
                "m_algorithm" "string" "Box"
                "m_stringArg" "string" ""
                "m_vFloat4Arg" "vector4" "0 0 0 0"
            }
            "m_outputColorSpace" "string" "srgb"
        }
    ]
    "m_vClamp" "vector3" "0 0 0"
    "m_bNoLod" "bool" "0"
}
"@
    $Utf8NoBom = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllText($vtexPath, $vtexContent, $Utf8NoBom)
    
    return $vtexPath
}

$DefaultConfig = [ordered]@{
    CsdkPath        = "C:\Reduced_CSDK_12"
    VrfCliPath      = "C:\VRF\Source2Viewer-CLI.exe"
    AutoCompileVtex = $true
}

if (-not (Test-Path $ConfigPath)) {
    $DefaultConfig | ConvertTo-Json -Depth 2 | Set-Content $ConfigPath -Encoding UTF8
    $Config = $DefaultConfig
    Write-Host "Created default config.json" -ForegroundColor DarkGray
} else {
    try {
        $Config = Get-Content $ConfigPath -Raw | ConvertFrom-Json
    } catch {
        Write-Host "ERROR: texture_config.json is corrupted. Using defaults." -ForegroundColor Red
        $Config = $DefaultConfig
    }
}

$CsdkRoot = $Config.CsdkPath
if (-not (Test-Path (Join-Path $CsdkRoot "game\bin_cs2\win64\resourcecompiler.exe"))) {
    $NestedRoot = Join-Path $CsdkRoot "Reduced_CSDK_12"
    if (Test-Path (Join-Path $NestedRoot "game\bin_cs2\win64\resourcecompiler.exe")) {
        $CsdkRoot = $NestedRoot
    } else {
        Write-Host "ERROR: CSDK not found at $CsdkRoot." -ForegroundColor Red
        Write-Host "Please set the correct path in texture_config.json." -ForegroundColor Yellow
        Wait-KeyPressAndExit
    }
}

$Compiler = Join-Path $CsdkRoot "game\bin_cs2\win64\resourcecompiler.exe"

Clear-Host
Write-Host "=== Deadlock Texture Tool ===" -ForegroundColor Cyan
Write-Host "Tip: Drag and drop .vtex_c or .png files onto DragAndDrop.bat`n" -ForegroundColor DarkGray

if ($DroppedFiles.Count -eq 0) {
    Write-Host "ERROR: No files were dropped!" -ForegroundColor Red
    Wait-KeyPressAndExit
}

Write-Host "Processing $($DroppedFiles.Count) file(s)...`n" -ForegroundColor White

foreach ($file in $DroppedFiles) {
    if (-not (Test-Path $file)) { continue }
    
    $fileInfo = Get-Item $file
    $ext = $fileInfo.Extension.ToLower()
    $dir = $fileInfo.DirectoryName

    if ($ext -eq ".vtex_c") {
        Write-Host "[>] Decompiling: $($fileInfo.Name)" -ForegroundColor Cyan
        
        if (-not (Test-Path $Config.VrfCliPath)) {
            Write-Host "  [!] ERROR: Source2Viewer-CLI not found at $($Config.VrfCliPath)." -ForegroundColor Red
            continue
        }

        $outputArgs = @("-i", $fileInfo.FullName, "-o", $dir, "-d")
        $VrfDir = Split-Path $Config.VrfCliPath
        
        $ProcessParams = @{
            FilePath = $Config.VrfCliPath
            ArgumentList = $outputArgs
            WorkingDirectory = $VrfDir
            NoNewWindow = $true
            Wait = $true
        }
        Start-Process @ProcessParams
        
        $baseName = $fileInfo.BaseName
        $extractedPng = Join-Path $dir "$baseName.png"
        $extractedTga = Join-Path $dir "$baseName.tga"
        
        $foundImage = $null
        if (Test-Path $extractedPng) { $foundImage = $extractedPng }
        elseif (Test-Path $extractedTga) { $foundImage = $extractedTga }
        
        if ($foundImage) {
            $vtexPath = Generate-VtexFile $foundImage
            Write-Host "  [OK] Extraction complete. Generated .png and .vtex" -ForegroundColor Green
        } else {
            Write-Host "  [OK] Extraction complete (image not found for .vtex)." -ForegroundColor Yellow
        }
    }
    elseif ($ext -eq ".png" -or $ext -eq ".tga") {
        Write-Host "[>] Generating .vtex for: $($fileInfo.Name)" -ForegroundColor Cyan
        
        $vtexPath = Generate-VtexFile $fileInfo.FullName
        Write-Host "  [OK] Created file: $([System.IO.Path]::GetFileName($vtexPath))" -ForegroundColor Green

        if ($Config.AutoCompileVtex) {
            if (-not (Test-Path $Compiler)) {
                Write-Host "  [!] ERROR: Compiler not found at $Compiler" -ForegroundColor Red
                continue
            }

            Write-Host "  [>] Compiling to .vtex_c..." -ForegroundColor DarkGray
            
            $compilerArgs = @("-i", $vtexPath, "-nop4")
            $ProcessParams = @{
                FilePath = $Compiler
                ArgumentList = $compilerArgs
                NoNewWindow = $true
                Wait = $true
            }
            Start-Process @ProcessParams
            
            Write-Host "  [OK] Compiled to .vtex_c" -ForegroundColor Green
        }
    }
    else {
        Write-Host "  [!] Skipped unsupported format: $($fileInfo.Name)" -ForegroundColor DarkGray
    }
}

Wait-KeyPressAndExit