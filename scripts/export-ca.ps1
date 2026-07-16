# Export the Windows trusted-root + intermediate CA stores to a PEM bundle so
# Node/npm can trust a corporate TLS-interception CA. See README "Behind a
# corporate TLS proxy?". Run in PowerShell:  powershell -File scripts\export-ca.ps1
$out = Join-Path $env:USERPROFILE 'corp-ca-bundle.pem'
$stores = @(
  'Cert:\LocalMachine\Root',
  'Cert:\CurrentUser\Root',
  'Cert:\LocalMachine\CA',
  'Cert:\CurrentUser\CA'
)
$lines = New-Object System.Collections.Generic.List[string]
$count = 0
foreach ($s in $stores) {
  Get-ChildItem $s -ErrorAction SilentlyContinue | ForEach-Object {
    $lines.Add('-----BEGIN CERTIFICATE-----')
    $lines.Add([Convert]::ToBase64String($_.RawData, 'InsertLineBreaks'))
    $lines.Add('-----END CERTIFICATE-----')
    $count++
  }
}
[System.IO.File]::WriteAllLines($out, $lines)
Write-Output "wrote $count certificates to $out"
