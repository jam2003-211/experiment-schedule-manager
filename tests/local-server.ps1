param(
  [Parameter(Mandatory = $true)][string]$Root,
  [int]$Port = 8765
)
$ErrorActionPreference = 'Stop'
$resolvedRoot = (Resolve-Path -LiteralPath $Root).Path.TrimEnd('\')
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $Port)
$listener.Start()
try {
  while ($true) {
    $client = $listener.AcceptTcpClient()
    try {
      $stream = $client.GetStream()
      $reader = [IO.StreamReader]::new($stream, [Text.Encoding]::ASCII, $false, 4096, $true)
      $requestLine = $reader.ReadLine()
      while ($reader.ReadLine()) {}
      $parts = $requestLine -split ' '
      $relative = if ($parts.Count -ge 2) { [Uri]::UnescapeDataString(($parts[1] -split '\?')[0]).TrimStart('/') } else { '' }
      if (-not $relative) { $relative = 'index.html' }
      $candidate = [IO.Path]::GetFullPath((Join-Path $resolvedRoot ($relative -replace '/', '\')))
      $allowed = $candidate -eq $resolvedRoot -or $candidate.StartsWith($resolvedRoot + '\', [StringComparison]::OrdinalIgnoreCase)
      if ($allowed -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
        $body = [IO.File]::ReadAllBytes($candidate)
        $mime = switch ([IO.Path]::GetExtension($candidate).ToLowerInvariant()) { '.html' { 'text/html; charset=utf-8' } '.js' { 'text/javascript; charset=utf-8' } '.css' { 'text/css; charset=utf-8' } '.json' { 'application/json; charset=utf-8' } default { 'application/octet-stream' } }
        $header = "HTTP/1.1 200 OK`r`nContent-Type: $mime`r`nContent-Length: $($body.Length)`r`nCache-Control: no-store`r`nConnection: close`r`n`r`n"
      } else {
        $body = [Text.Encoding]::UTF8.GetBytes('Not found')
        $header = "HTTP/1.1 404 Not Found`r`nContent-Type: text/plain; charset=utf-8`r`nContent-Length: $($body.Length)`r`nConnection: close`r`n`r`n"
      }
      $headerBytes = [Text.Encoding]::ASCII.GetBytes($header)
      $stream.Write($headerBytes, 0, $headerBytes.Length)
      $stream.Write($body, 0, $body.Length)
      $stream.Flush()
    } catch {
      # Browsers may open and abandon speculative connections. Keep serving later requests.
    } finally { $client.Dispose() }
  }
} finally { $listener.Stop() }
