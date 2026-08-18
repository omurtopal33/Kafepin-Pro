#!/usr/bin/env bash
set -euo pipefail

curl -fL --retry 3 -o /tmp/v325.zip 'https://raw.githubusercontent.com/omurtopal33/Kafepin-Pro/main/KafePin-Pro-Update-v3.1.25.zip'
curl -fL --retry 3 -o /tmp/v322.zip 'https://raw.githubusercontent.com/omurtopal33/Kafepin-Pro/main/KafePin-Pro-Update-v3.1.22.zip'
rm -rf build && mkdir build
unzip -q /tmp/v325.zip -d build
unzip -p /tmp/v322.zip KafePin_System_Manager.ps1 > build/KafePin_System_Manager.ps1
unzip -p /tmp/v322.zip KafePin_Manager_Ensure.ps1 > build/KafePin_Manager_Ensure.ps1
(cd build && patch -p1 < ../.github/v326/explorer.patch)
(cd build && patch -p1 < ../.github/v326/server.patch)
(cd build && patch -p1 < ../.github/v326/management.patch)
cp .github/v326/kafepin-pro-version.json build/kafepin-pro-version.json
cp .github/v326/update.json build/update.json

checks=(
'4d0a4f48f11870dc00a74caca372bf941cfb3a2531c90b04c3ffcab4d84ca964  build/server.js'
'a80fa4e716cb517e60600fed3541dcaca17e9498040ffd7a7bb350317c74b75d  build/KafePin_System_Manager.ps1'
'b53fbbb055ec8427f5b61e0e466c76325a067f6c72017416319347982df1136c  build/KafePin_Manager_Ensure.ps1'
'0923235b8e2570461ac9a57798ae7bfaf27f69b380834180cf46855cd2f77a9f  build/public/admin.html'
'5c07e7352e6aed965c4523d27824240d430f69b7625e6316833d6ccd0ba3e028  build/public/kafepin-pro-yonetim.html'
'2996506f48d05be4829798bc5906f126959ce9a42e87e933f7286ce837b8145c  build/kafepin-pro-version.json'
'da027cefeee2d7fa1d2b14eb1af20843ae47d61cd758f2d68fa0fa1b780ac1fc  build/update.json'
)
printf '%s\n' "${checks[@]}" | sha256sum -c -
node --check build/server.js

python3 - <<'PY'
import re,pathlib,subprocess
for p in [pathlib.Path('build/public/admin.html'),pathlib.Path('build/public/kafepin-pro-yonetim.html')]:
    for i,x in enumerate(re.findall(r'<script[^>]*>(.*?)</script>',p.read_text(encoding='utf-8'),re.S|re.I)):
        q=pathlib.Path('/tmp')/(p.stem+f'_{i}.js')
        q.write_text(x,encoding='utf-8')
        subprocess.run(['node','--check',str(q)],check=True)
print('INLINE_JS_OK')
PY

rm -f KafePin-Pro-Update-v3.1.26.zip
(cd build && zip -q -r ../KafePin-Pro-Update-v3.1.26.zip server.js KafePin_System_Manager.ps1 KafePin_Manager_Ensure.ps1 public/admin.html public/kafepin-pro-yonetim.html kafepin-pro-version.json update.json)
unzip -t KafePin-Pro-Update-v3.1.26.zip
ZIP_SHA="$(sha256sum KafePin-Pro-Update-v3.1.26.zip | awk '{print $1}')"
export ZIP_SHA
python3 - <<'PY'
import json,os
from datetime import datetime,timezone,timedelta
u=json.load(open('build/update.json',encoding='utf-8'))
out={'version':'3.1.26','publishedAt':datetime.now(timezone(timedelta(hours=3))).isoformat(timespec='seconds'),'notes':u['notes'],'downloadUrl':'https://raw.githubusercontent.com/omurtopal33/Kafepin-Pro/main/KafePin-Pro-Update-v3.1.26.zip','sha256':os.environ['ZIP_SHA']}
with open('latest.json','w',encoding='utf-8') as f:
    json.dump(out,f,ensure_ascii=False,indent=2); f.write('\n')
print('GITHUB_ZIP_SHA256='+os.environ['ZIP_SHA'])
PY

git config user.name 'KafePin Update Bot'
git config user.email 'actions@users.noreply.github.com'
rm -rf .github/v326 .github/workflows/publish-v326-cumulative.yml
git add -A
git commit -m 'KafePin: v3.1.26 cumulative publish'
git push
