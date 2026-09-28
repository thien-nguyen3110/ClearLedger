# Launch the frozen local UI and API without database, Redis, or Kafka services.
[CmdletBinding()]
param(
    [ValidateRange(1, 65535)][int]$Port = 18080,
    [string]$OllamaUrl = '',
    [string]$Model = 'qwen3:4b-instruct-2507-q4_K_M',
    [switch]$Check,
    [switch]$CheckModel
)
$ErrorActionPreference = 'Stop'
if ($CheckModel -and -not $OllamaUrl) {
    throw '-CheckModel requires -OllamaUrl http://127.0.0.1:11434'
}
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$backend = Join-Path $taskRoot 'backend'
$go = (Get-Command go -CommandType Application -ErrorAction Stop).Source
$settings = @{
    ADDR = "127.0.0.1:$Port"
    DATABASE_URL = ''
    REDIS_URL = ''
    KAFKA_BROKERS = ''
    OLLAMA_URL = $OllamaUrl
    OLLAMA_MODEL = $Model
    STATE_PATH = (Join-Path $backend 'data/local/state.json')
    WEB_DIR = (Join-Path $taskRoot 'web/dist')
    SAMPLE_DIR = (Join-Path $taskRoot 'samples')
}
$previous = @{}
foreach ($name in $settings.Keys) {
    $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
try {
    foreach ($name in $settings.Keys) {
        [Environment]::SetEnvironmentVariable($name, $settings[$name], 'Process')
    }
    Push-Location -LiteralPath $backend
    try {
        # API_TOKEN, if deliberately set by the caller, is inherited but never printed.
        if ($CheckModel) { & $go run . check --model }
        elseif ($Check) { & $go run . check }
        else { & $go run . }
        if ($LASTEXITCODE -ne 0) { throw "ClearLedger exited with code $LASTEXITCODE." }
    } finally {
        Pop-Location
    }
} finally {
    foreach ($name in $settings.Keys) {
        [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process')
    }
}
