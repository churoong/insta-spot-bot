# 노트북 → 폰 이전용 묶음 만들기(2026-10-27). 로그인 세션·.env 등 비밀이 들어 있으니
# USB나 본인만 보는 저장소로 옮기고, 폰에서 가져온 뒤에는 이 zip을 지울 것.
#   powershell -ExecutionPolicy Bypass -File private\export-for-phone.ps1
$repo = Split-Path $PSScriptRoot -Parent
$tmp = Join-Path $env:TEMP "insta-agent-transfer"
Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force (Join-Path $tmp "private\state") | Out-Null
Copy-Item (Join-Path $repo ".env") $tmp
Get-ChildItem (Join-Path $repo "private\state") -File | Copy-Item -Destination (Join-Path $tmp "private\state")
$zip = Join-Path ([Environment]::GetFolderPath("Desktop")) "insta-agent-transfer.zip"
Remove-Item $zip -Force -ErrorAction SilentlyContinue
Compress-Archive -Path (Join-Path $tmp "*") -DestinationPath $zip
Remove-Item $tmp -Recurse -Force
Write-Output "만들었습니다: $zip  (폰 '다운로드' 폴더로 옮기세요)"
