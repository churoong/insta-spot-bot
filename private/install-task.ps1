# 비공식 API 에이전트를 Windows 로그온 시 자동 실행으로 등록한다(사용자 권한, 창 없이 pythonw).
#   powershell -ExecutionPolicy Bypass -File private\install-task.ps1
# 해제: schtasks /Delete /TN insta-private-agent /F
$py = (Get-Command pythonw.exe -ErrorAction Stop).Source
$agent = Join-Path $PSScriptRoot "agent.py"
$action = New-ScheduledTaskAction -Execute $py -Argument "`"$agent`"" -WorkingDirectory $PSScriptRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 99 -RestartInterval (New-TimeSpan -Minutes 5) -ExecutionTimeLimit (New-TimeSpan -Days 0)
Register-ScheduledTask -TaskName "insta-private-agent" -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName "insta-private-agent"
Write-Output "등록·시작 완료: insta-private-agent ($py $agent)"
