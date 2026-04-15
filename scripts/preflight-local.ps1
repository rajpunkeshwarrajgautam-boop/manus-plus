param(
  [switch]$SkipVerifyOps
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$ports = @(3000, 4100, 4101, 4102, 4103)

Write-Host "[preflight] Clearing listeners on ports: $($ports -join ', ')"

foreach ($port in $ports) {
  $listeners = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  foreach ($listener in $listeners) {
    $pid = $listener.OwningProcess
    if ($pid -and $pid -ne 0) {
      try {
        $proc = Get-Process -Id $pid -ErrorAction SilentlyContinue
        if ($proc) {
          Write-Host "[preflight] Stopping PID $pid ($($proc.ProcessName)) on port $port"
        } else {
          Write-Host "[preflight] Stopping PID $pid on port $port"
        }
        Stop-Process -Id $pid -Force -ErrorAction Stop
      } catch {
        Write-Warning "[preflight] Could not stop PID $pid on port ${port}: $($_.Exception.Message)"
      }
    }
  }
}

if ($SkipVerifyOps) {
  Write-Host "[preflight] Port cleanup completed; skipping verify:ops"
  exit 0
}

Write-Host "[preflight] Running npm run verify:ops"
Set-Location $repoRoot
npm run verify:ops
$exitCode = $LASTEXITCODE

if ($exitCode -eq 0) {
  Write-Host "[preflight] verify:ops PASSED"
} else {
  Write-Error "[preflight] verify:ops FAILED (exit code: $exitCode)"
}

exit $exitCode
