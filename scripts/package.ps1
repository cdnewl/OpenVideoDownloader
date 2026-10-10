# Package the extension into dist/open-video-downloader.zip for store upload.
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root "dist"
$zip = Join-Path $dist "open-video-downloader.zip"

if (Test-Path $dist) { Remove-Item -Recurse -Force $dist }
New-Item -ItemType Directory -Path $dist | Out-Null

$include = @(
  "manifest.json",
  "_locales",
  "background",
  "content",
  "lib",
  "popup",
  "manager",
  "options",
  "icons"
)

$temp = Join-Path $env:TEMP "ovd-pack-$(Get-Random)"
New-Item -ItemType Directory -Path $temp | Out-Null
foreach ($item in $include) {
  Copy-Item -Recurse -Path (Join-Path $root $item) -Destination $temp
}

Compress-Archive -Path (Join-Path $temp "*") -DestinationPath $zip -Force
Remove-Item -Recurse -Force $temp

Write-Host "Packaged: $zip"
Get-Item $zip | Select-Object Name, Length
