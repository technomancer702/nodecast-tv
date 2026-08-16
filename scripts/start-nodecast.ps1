param(
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$dockerDesktop = 'C:\Program Files\Docker\Docker\Docker Desktop.exe'
$nodeCastUrl = 'http://127.0.0.1:3000'

function Test-DockerEngine {
    & docker info *> $null
    return $LASTEXITCODE -eq 0
}

try {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        throw 'Docker não foi encontrado. Instale o Docker Desktop antes de iniciar o NodeCast.'
    }

    if (-not (Test-DockerEngine)) {
        if (-not (Test-Path -LiteralPath $dockerDesktop)) {
            throw 'Docker Desktop não foi encontrado no local esperado.'
        }

        Start-Process -FilePath $dockerDesktop -WindowStyle Hidden
        $dockerDeadline = (Get-Date).AddMinutes(2)
        do {
            Start-Sleep -Seconds 2
            $dockerReady = Test-DockerEngine
        } until ($dockerReady -or (Get-Date) -gt $dockerDeadline)

        if (-not $dockerReady) {
            throw 'O Docker Desktop não ficou disponível dentro de dois minutos.'
        }
    }

    Push-Location -LiteralPath $projectRoot
    try {
        & docker compose up -d
        if ($LASTEXITCODE -ne 0) {
            throw 'Não foi possível iniciar o container do NodeCast.'
        }
    } finally {
        Pop-Location
    }

    $healthDeadline = (Get-Date).AddMinutes(1)
    do {
        Start-Sleep -Seconds 1
        $health = & docker inspect nodecast-tv --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' 2>$null
    } until ($health -eq 'healthy' -or (Get-Date) -gt $healthDeadline)

    if ($health -ne 'healthy') {
        throw "O NodeCast iniciou, mas não ficou saudável (estado: $health)."
    }

    if (-not $NoBrowser) {
        Start-Process $nodeCastUrl
    }
} catch {
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show(
        $_.Exception.Message,
        'NodeCast TV',
        [System.Windows.MessageBoxButton]::OK,
        [System.Windows.MessageBoxImage]::Error
    ) | Out-Null
    exit 1
}
