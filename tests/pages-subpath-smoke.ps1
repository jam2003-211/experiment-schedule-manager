param(
  [int]$Port = 8877
)
$ErrorActionPreference = 'Stop'

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$serverScript = Join-Path $PSScriptRoot 'local-server.ps1'
$temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) ("experiment-pages-smoke-" + [Guid]::NewGuid().ToString('N'))
$repositoryName = 'experiment-schedule-manager'
$publishedRoot = Join-Path $temporaryRoot $repositoryName
$server = $null

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

function Wait-ForServer([string]$Url, [int]$TimeoutSeconds = 10) {
  $limit = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    try {
      if ((Invoke-WebRequest -UseBasicParsing $Url -TimeoutSec 1).StatusCode -eq 200) { return $true }
    } catch {}
    Start-Sleep -Milliseconds 100
  } while ((Get-Date) -lt $limit)
  return $false
}

try {
  New-Item -ItemType Directory -Path $publishedRoot -Force | Out-Null
  @('index.html', 'styles.css', 'core.js', 'app.js', '.nojekyll') |
    ForEach-Object { Copy-Item -LiteralPath (Join-Path $projectRoot $_) -Destination $publishedRoot }

  $serverOut = Join-Path $temporaryRoot 'server.out.log'
  $serverErr = Join-Path $temporaryRoot 'server.err.log'
  $server = Start-Process -FilePath 'powershell.exe' -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $serverScript,
    '-Root', $temporaryRoot, '-Port', $Port
  ) -PassThru -WindowStyle Hidden -RedirectStandardOutput $serverOut -RedirectStandardError $serverErr

  $baseUrl = "http://127.0.0.1:$Port/$repositoryName/"
  Assert-True (Wait-ForServer ($baseUrl + 'index.html')) "Subpath server did not start at $baseUrl"

  $indexResponse = Invoke-WebRequest -UseBasicParsing ($baseUrl + 'index.html')
  Assert-True ($indexResponse.StatusCode -eq 200) 'index.html was not served from the repository subpath.'
  Assert-True ($indexResponse.Content -notmatch '(?:src|href)=["'']/') 'index.html contains a root-absolute asset path.'

  $assetPaths = @('styles.css', 'core.js', 'app.js')
  foreach ($assetPath in $assetPaths) {
    $resolvedUrl = [Uri]::new([Uri]$baseUrl, $assetPath).AbsoluteUri
    $response = Invoke-WebRequest -UseBasicParsing $resolvedUrl
    Assert-True ($response.StatusCode -eq 200) "$assetPath was not served from the repository subpath."
  }

  Assert-True ($indexResponse.Content -notmatch 'optimizer(?:-worker)?\.js') 'Removed optimizer assets are still referenced by index.html.'

  Write-Output "PAGES_SUBPATH_SMOKE_PASSED=True"
  Write-Output "PAGES_SUBPATH_URL=$baseUrl"
  Write-Output "CHECKED_ASSETS=$($assetPaths.Count)"
}
finally {
  if ($server -and -not $server.HasExited) { try { Stop-Process -Id $server.Id -Force } catch {} }
  Start-Sleep -Milliseconds 300
  if (Test-Path -LiteralPath $temporaryRoot) {
    $resolvedTemporaryRoot = (Resolve-Path -LiteralPath $temporaryRoot).Path
    $systemTemporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
    $safeName = (Split-Path -Leaf $resolvedTemporaryRoot) -like 'experiment-pages-smoke-*'
    if (-not ($safeName -and $resolvedTemporaryRoot.StartsWith($systemTemporaryRoot + '\', [StringComparison]::OrdinalIgnoreCase))) {
      throw "Unsafe smoke-test cleanup target: $resolvedTemporaryRoot"
    }
    Remove-Item -LiteralPath $resolvedTemporaryRoot -Recurse -Force
  }
}
