# Run a local-only Ollama server in this terminal; downloads are an explicit step.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$ollama = (Get-Command ollama -CommandType Application -ErrorAction Stop).Source
$settings = @{ OLLAMA_HOST = '127.0.0.1:11434'; OLLAMA_NO_CLOUD = '1' }
$previous = @{}
foreach ($name in $settings.Keys) {
    $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
try {
    foreach ($name in $settings.Keys) {
        [Environment]::SetEnvironmentVariable($name, $settings[$name], 'Process')
    }
    Write-Host 'Starting local-only Ollama on 127.0.0.1:11434. No model is downloaded by this script.'
    & $ollama serve
    if ($LASTEXITCODE -ne 0) {
        throw 'Ollama stopped. If the port is occupied, use the existing server or quit it yourself before retrying.'
    }
} finally {
    foreach ($name in $settings.Keys) {
        [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process')
    }
}
