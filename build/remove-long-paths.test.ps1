# Isolated long-path removal tests, compatible with Windows PowerShell 5.1 and PowerShell 7.
# Everything happens in one scratch directory under the system temp folder. Limits are
# derived from the scratch path lengths, so the same scenarios hold on any machine.
$ErrorActionPreference = 'Stop'
$onWindows = [Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT
$scratch = [IO.Path]::Combine([IO.Path]::GetTempPath(), 'tt-long-paths-test-' + [guid]::NewGuid())
[void][IO.Directory]::CreateDirectory($scratch)
$log = [IO.Path]::Combine($scratch, 'diagnostics.log')
. "$PSScriptRoot/remove-long-paths.ps1" -InstallDirectory $scratch -StagingDirectory $scratch -LogPath $log

function Assert($Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}
function Join-Parts([string[]]$Parts) {
    $path = $Parts[0]
    foreach ($part in $Parts[1..($Parts.Count - 1)]) { $path = [IO.Path]::Combine($path, $part) }
    $path
}
function New-TestFile([string]$Directory, [string]$Name) {
    [void][IO.Directory]::CreateDirectory((Get-IoPath $Directory))
    $path = [IO.Path]::Combine($Directory, $Name)
    [IO.File]::WriteAllText((Get-IoPath $path), 'x')
    $path
}
function Test-Present([string]$Path) {
    $io = Get-IoPath $Path
    [IO.File]::Exists($io) -or [IO.Directory]::Exists($io)
}
function Run([string]$App, [string]$Staging, [int]$FileLimit, [int]$DirectoryLimit) {
    Invoke-TTRemoveLongPaths -InstallDirectory $App -StagingDirectory $Staging -LogPath $log `
        -FileLimit $FileLimit -DirectoryLimit $DirectoryLimit
}

$passed = 0
$link = $null
try {
    $app = [IO.Path]::Combine($scratch, 'App')
    [void][IO.Directory]::CreateDirectory($app)
    Assert ((Run $app $scratch 256 244) -eq 0) 'A missing resources directory is not an error.'
    $passed++

    Assert ((Run ([IO.Path]::GetPathRoot($scratch)) $scratch 256 244) -eq 20) 'A drive root must never be accepted as an app directory.'
    $passed++

    # Lengths count from the end of the app directory, as NSIS does.
    $modules = Join-Parts @($app, 'resources', 'pi', 'node_modules')
    $deepDirectory = [IO.Path]::Combine($modules, ('d' * 30))
    $short = New-TestFile $modules 'short.js'
    $boundary = New-TestFile $modules ('b' * 40 + '.js')
    $long = New-TestFile $deepDirectory ('f' * 60 + '.js')
    $outside = New-TestFile $app ('o' * 120 + '.txt')
    $fileLimit = $long.Length
    Assert ($boundary.Length -lt $fileLimit -and $short.Length -lt $boundary.Length) 'Fixture lengths must be ordered.'
    $result = Run $app $app $fileLimit ($deepDirectory.Length)
    Assert ($result -eq 0) "Removal must succeed (exit $result)."
    Assert (-not (Test-Present $long)) 'A file at the limit must be removed.'
    Assert (-not (Test-Present $deepDirectory)) 'An emptied directory at its limit must be removed.'
    Assert ((Test-Present $short) -and (Test-Present $boundary)) 'Files below the limit must survive.'
    Assert (Test-Present $outside) 'Nothing outside resources may be touched.'
    $passed++

    # The staging base is longer than the app directory: it alone makes the entry
    # blocking. The boundary file is ten characters shorter and must stay.
    $staged = New-TestFile $modules ('s' * 50 + '.js')
    $offset = 50
    $staging = $app + ('x' * $offset)
    $limit = $staged.Length + $offset
    Assert ((Run $app $app $limit 9999) -eq 0 -and (Test-Present $staged)) 'Below the limit against the app directory.'
    Assert ((Run $app $staging $limit 9999) -eq 0 -and -not (Test-Present $staged)) 'The longer staging base must decide.'
    Assert ((Test-Present $boundary) -and (Test-Present $short)) 'Only entries over the staging limit go.'
    $passed++

    # A link inside resources is reported and never followed.
    $target = [IO.Path]::Combine($scratch, 'Outside')
    $kept = New-TestFile $target ('k' * 60 + '.js')
    $link = [IO.Path]::Combine($modules, 'linked')
    if ($onWindows) { New-Item -ItemType Junction -Path $link -Target $target | Out-Null }
    else { New-Item -ItemType SymbolicLink -Path $link -Target $target | Out-Null }
    $result = Run $app $app ([IO.Path]::Combine($link, 'k' * 60 + '.js').Length) 9999
    Assert ($result -eq 0) "A link must not fail the run (exit $result)."
    Assert ((Test-Present $kept) -and (Test-Present $link)) 'A link and its target must survive.'
    $passed++

    Assert ((ConvertTo-ExtendedPath 'C:\Users\a b\TipATask') -eq '\\?\C:\Users\a b\TipATask') 'Drive paths take the \\?\ prefix.'
    Assert ((ConvertTo-ExtendedPath '\\server\share\TipATask') -eq '\\?\UNC\server\share\TipATask') 'UNC paths take the \\?\UNC\ prefix.'
    Assert ((ConvertTo-ExtendedPath '\\?\C:\x') -eq '\\?\C:\x') 'Prefixed paths are unchanged.'
    $passed++

    # The script's own process exit code carries the result: no stray pipeline output.
    $child = New-TestFile $deepDirectory ('c' * 60 + '.js')
    $shell = (Get-Process -Id $PID).Path
    & $shell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PSScriptRoot/remove-long-paths.ps1" `
        -InstallDirectory $app -StagingDirectory $app -LogPath $log -FileLimit $child.Length -DirectoryLimit 9999 | Out-Null
    Assert ($LASTEXITCODE -eq 0 -and -not (Test-Present $child)) "The script must exit 0 after removing (exit $LASTEXITCODE)."
    $passed++

    if ($onWindows) {
        # Past MAX_PATH for real: only the \\?\ form can create or remove these.
        $deep = Join-Parts @($modules, ('n' * 120), ('m' * 120))
        $tooLong = New-TestFile $deep ('p' * 40 + '.js')
        Assert ($tooLong.Length -gt 300) 'The Windows fixture must exceed MAX_PATH.'
        Assert ((Run $app $app 256 244) -eq 0) 'Removal past MAX_PATH must succeed.'
        Assert (-not (Test-Present $tooLong) -and -not (Test-Present $deep)) 'Entries past MAX_PATH must be gone.'
        $passed++
    }

    $contents = Get-Content -LiteralPath $log -Raw
    Assert ($contents.Contains('removed length=') -and $contents.Contains('skipped link') -and $contents.Contains('scanned=')) 'Log must record removals, skipped links and the scan.'
    Write-Output "PASS: $passed isolated long-path scenarios"
} finally {
    if ($link -and (Test-Path -LiteralPath $link)) {
        if ($onWindows) { [IO.Directory]::Delete($link, $false) } else { Remove-Item -LiteralPath $link -Force }
    }
    try { Remove-Item -LiteralPath (Get-IoPath $scratch) -Recurse -Force } catch { Write-Warning "cleanup: $($_.Exception.Message)" }
}
