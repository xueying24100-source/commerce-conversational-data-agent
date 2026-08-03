$ErrorActionPreference = 'Stop'

$scriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = (Resolve-Path (Join-Path $scriptDirectory '..\..')).Path
$managedEnvironment = @(
  'COMMERCE_TEST_DATABASE_URL',
  'COMMERCE_TEST_DATABASE_CONFIRM',
  'COMMERCE_LIVE_E2E_DATABASE_URL',
  'COMMERCE_LIVE_E2E_CONFIRM',
  'COMMERCE_LIVE_E2E_MODEL',
  'COMMERCE_RELEASE_REVISION',
  'DEEPSEEK_API_KEY',
  'NODE_TLS_REJECT_UNAUTHORIZED'
)
$previousEnvironment = @{}
foreach ($name in $managedEnvironment) {
  $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}

$secureKey = $null
$keyPointer = [IntPtr]::Zero
$clipboardUsed = $false
$exitCode = 1

try {
  Push-Location $projectRoot
  try {
    $dirty = git status --porcelain
    if ($LASTEXITCODE -ne 0) {
      throw 'The project must be a Git repository before release evidence can run.'
    }
    if ($dirty) {
      throw 'Commit all working-tree changes before release evidence can run.'
    }

    docker compose -f compose.commerce.local.yml up -d --wait postgres
    if ($LASTEXITCODE -ne 0) {
      throw 'Commerce PostgreSQL failed to become healthy.'
    }

    $revision = ((git rev-parse HEAD) -join '').Trim()
    if ($LASTEXITCODE -ne 0 -or $revision -notmatch '^[0-9a-f]{40}$') {
      throw 'A committed 40-character Git revision is required.'
    }

    $secureKey = Read-Host 'Enter the NEW DeepSeek API Key (input is hidden)' -AsSecureString
    $keyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
    $plainKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPointer)
    if ([string]::IsNullOrWhiteSpace($plainKey) -or $plainKey.Length -lt 16) {
      [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer)
      $keyPointer = [IntPtr]::Zero
      $secureKey = $null
      $plainKey = $null
      Write-Host 'The secure console did not receive the pasted value.'
      Write-Host 'Copy the NEW DeepSeek API Key to the clipboard, then press Enter.'
      [void](Read-Host)
      $clipboardUsed = $true
      $plainKey = (Get-Clipboard -Raw).Trim()
      Set-Clipboard -Value ''
      if ([string]::IsNullOrWhiteSpace($plainKey) -or $plainKey.Length -lt 16) {
        throw 'The clipboard does not contain a valid DeepSeek API Key.'
      }
    }

    $env:COMMERCE_TEST_DATABASE_URL = 'postgresql://commerce_app:commerce_local_password@127.0.0.1:35433/commerce_agent'
    $env:COMMERCE_TEST_DATABASE_CONFIRM = 'commerce-integration'
    $env:COMMERCE_LIVE_E2E_DATABASE_URL = $env:COMMERCE_TEST_DATABASE_URL
    $env:COMMERCE_LIVE_E2E_CONFIRM = 'commerce-live-e2e'
    $env:COMMERCE_LIVE_E2E_MODEL = 'deepseek-v4-flash'
    $env:COMMERCE_RELEASE_REVISION = $revision
    $env:DEEPSEEK_API_KEY = $plainKey
    $env:NODE_TLS_REJECT_UNAUTHORIZED = '1'
    $plainKey = $null

    npm run release:check:evidence
    $exitCode = $LASTEXITCODE
  } finally {
    Pop-Location
  }
} catch {
  Write-Error $_
  $exitCode = 1
} finally {
  if ($keyPointer -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer)
  }
  if ($clipboardUsed) {
    Set-Clipboard -Value ''
  }
  $secureKey = $null
  foreach ($name in $managedEnvironment) {
    $previous = $previousEnvironment[$name]
    if ($null -eq $previous) {
      Remove-Item "Env:$name" -ErrorAction SilentlyContinue
    } else {
      [Environment]::SetEnvironmentVariable($name, $previous, 'Process')
    }
  }
}

exit $exitCode
