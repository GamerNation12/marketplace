[CmdletBinding()]
param(
    [Parameter()]
    [switch]$BypassAdmin
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Invoke-Spicetify {
    param (
        [Parameter(Mandatory = $true, Position = 0, ValueFromRemainingArguments = $true)]
        [string[]]$Arguments
    )
    
    $spicetifyArgs = @()
    if ($BypassAdmin) {
        $spicetifyArgs += "--bypass-admin"
    }
    $spicetifyArgs += $Arguments
    
    & spicetify $spicetifyArgs
    return $LASTEXITCODE
}

function Invoke-SpicetifyWithOutput {
    param (
        [Parameter(Mandatory = $true, Position = 0, ValueFromRemainingArguments = $true)]
        [string[]]$Arguments
    )
    
    $spicetifyArgs = @()
    if ($BypassAdmin) {
        $spicetifyArgs += "--bypass-admin"
    }
    $spicetifyArgs += $Arguments
    
    $output = (& spicetify $spicetifyArgs 2>&1 | Out-String).Trim()
    return @{
        Output = $output
        ExitCode = $LASTEXITCODE
    }
}

Write-Host -Object 'Setting up...' -ForegroundColor 'Cyan'

if (-not (Get-Command -Name 'spicetify' -ErrorAction 'SilentlyContinue')) {
    Write-Host -Object 'Spicetify not found.' -ForegroundColor 'Yellow'
    Write-Host -Object 'Installing it for you...' -ForegroundColor 'Cyan'
    $Parameters = @{
        Uri             = 'https://raw.githubusercontent.com/spicetify/cli/main/install.ps1'
        UseBasicParsing = $true
    }
    Invoke-WebRequest @Parameters | Invoke-Expression
}

try {
    $result = Invoke-SpicetifyWithOutput "path" "userdata"
    if ($result.ExitCode -ne 0) {
        Write-Host -Object "Error from Spicetify:" -ForegroundColor 'Red'
        return
    }
    $spiceUserDataPath = $result.Output
} catch {
    Write-Host -Object "Error running Spicetify:" -ForegroundColor 'Red'
    return
}

if (-not (Test-Path -Path $spiceUserDataPath -PathType 'Container' -ErrorAction 'SilentlyContinue')) {
    $spiceUserDataPath = "$env:APPDATA\spicetify"
}

# ------------------------------------------------------------------
# PATH FIX: Match the folder name created by spicetify-creator
# ------------------------------------------------------------------
$marketAppPath = "$spiceUserDataPath\CustomApps\marketplace"
$marketThemePath = "$spiceUserDataPath\Themes\marketplace"

$isThemeInstalled = $(
    Invoke-Spicetify "path" "-s" | Out-Null
    -not $LASTEXITCODE
)
$currentTheme = (Invoke-SpicetifyWithOutput "config" "current_theme").Output
$setTheme = $true

Write-Host -Object 'Cleaning and creating Marketplace folders...' -ForegroundColor 'Cyan'
try {
    # Remove old/incorrect folder names to prevent clashes
    Remove-Item -Path "$spiceUserDataPath\CustomApps\mgn-marketplace" -Recurse -Force -ErrorAction 'SilentlyContinue' | Out-Null
    Remove-Item -Path $marketAppPath, $marketThemePath -Recurse -Force -ErrorAction 'SilentlyContinue' | Out-Null
    
    New-Item -Path $marketAppPath, $marketThemePath -ItemType 'Directory' -Force -ErrorAction 'Stop' | Out-Null
} catch {
    Write-Host -Object "Error creating directories: $($_.Exception.Message.Trim())" -ForegroundColor 'Red'
    return
}

Write-Host -Object 'Downloading Marketplace...' -ForegroundColor 'Cyan'
$marketArchivePath = "$marketAppPath\marketplace.zip"
$Parameters = @{
  Uri             = 'https://github.com/GamerNation12/marketplace/releases/latest/download/marketplace.zip'
  UseBasicParsing = $true
  OutFile         = $marketArchivePath
}
Invoke-WebRequest @Parameters

Write-Host -Object 'Unzipping and installing...' -ForegroundColor 'Cyan'
Expand-Archive -Path $marketArchivePath -DestinationPath $marketAppPath -Force
Remove-Item -Path $marketArchivePath -Force

# ------------------------------------------------------------------
# REGISTRATION FIX: Remove ghost extensions and set the App
# ------------------------------------------------------------------
Write-Host -Object 'Registering Custom App...' -ForegroundColor 'Cyan'
Invoke-Spicetify "config" "extensions" "marketplace-" "mgn-marketplace-" "-q"
Invoke-Spicetify "config" "custom_apps" "spicetify-marketplace-" "mgn-marketplace-" "marketplace"
Invoke-Spicetify "config" "inject_css" "1" "replace_colors" "1"

Write-Host -Object 'Downloading placeholder theme...' -ForegroundColor 'Cyan'
$Parameters = @{
  Uri             = 'https://raw.githubusercontent.com/GamerNation12/marketplace/main/resources/color.ini'
  UseBasicParsing = $true
  OutFile         = "$marketThemePath\color.ini"
}
Invoke-WebRequest @Parameters

Write-Host -Object 'Applying changes...' -ForegroundColor 'Cyan'
if ($isThemeInstalled -and ($currentTheme -ne 'marketplace')) {
    $choice = $Host.UI.PromptForChoice(
        'Local theme found',
        'Replace with MGN Marketplace placeholder theme?',
        ('&Yes', '&No'),
        0
    )
    if ($choice -eq 1) { $setTheme = $false }
}

if ($setTheme) {
    Invoke-Spicetify "config" "current_theme" "marketplace"
}

Invoke-Spicetify "apply"

Write-Host -Object 'Done! Restarting Spotify...' -ForegroundColor 'Green'