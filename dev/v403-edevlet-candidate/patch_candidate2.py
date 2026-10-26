from pathlib import Path

p = Path('dev/v403-edevlet-candidate/build_v403_edevlet.py')
s = p.read_text(encoding='utf-8')

def one(old, new, label):
    global s
    n = s.count(old)
    if n != 1:
        raise SystemExit(f'{label}: expected 1 occurrence, found {n}')
    s = s.replace(old, new, 1)

one("OUT_NAME = 'KafePin-Pro-Update-v4.0.3-CANDIDATE.zip'", "OUT_NAME = 'KafePin-Pro-Update-v4.0.3-CANDIDATE3.zip'", 'out name')
one("NESTED = 'pro-components/yazici-pro.zip'\nALLOWED_OUTER = {'update.json', NESTED}", "NESTED = 'pro-components/yazici-pro.zip'\nSUPERVISOR = 'KafePin_Update_Supervisor.js'\nALLOWED_OUTER = {'update.json', NESTED, SUPERVISOR}", 'allowed outer')

insert = r'''

def patch_supervisor(text: str) -> str:
    old = """    const shell=await ensureDesktopShellExact(installRoot);
    const mp3=syncMp3Payload(installRoot,proRoot); await startAndVerifyMp3(mp3);
    const componentsSynced=syncPackagedProComponents(installRoot);
    let proServicesRefreshed=false;
    if(componentsSynced){ await runDesktopBridgeAction(installRoot,'refresh-pro-services',70000); proServicesRefreshed=true; }
    const desktopLaunched=!desktopWasRunning || shell.required;
"""
    new = """    // v4.0.3 candidate3: Yazici-only paket ana desktop kabugunu ve diger PRO'lari
    // gereksiz yere refresh etmez. Bu yol update.json files listesiyle fail-closed calisir.
    const installedMeta=readJson(path.join(installRoot,'kafepin-pro-version.json'))||{};
    const updateFiles=Array.isArray(installedMeta.files)?installedMeta.files.map(String):[];
    const componentOnly=updateFiles.length===2 && updateFiles.includes('KafePin_Update_Supervisor.js') && updateFiles.includes('pro-components/yazici-pro.zip');
    let shell={required:false,version:desktopExpectedVersion(installRoot)};
    let mp3={required:false,version:''};
    let componentsSynced=false;
    let proServicesRefreshed=false;
    if(componentOnly){
      const manager=path.join(installRoot,'KafePin_Pro_Component_Manager.ps1');
      if(!fs.existsSync(manager)) throw new Error('Yazici PRO component manager bulunamadi');
      const r=run('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',manager,'-Action','repair','-Component','yazici-pro'],{timeout:120000});
      if(r.code!==0) throw new Error(`Yazici PRO hedefli guncelleme basarisiz: ${(r.stderr||r.stdout).trim().slice(0,1800)}`);
      componentsSynced=true; proServicesRefreshed=true;
      log(installRoot,'component-only activation: Yazici PRO repaired; desktop shell and other PRO refresh skipped');
      const end=Date.now()+45000;
      let yazici={ok:false,details:''};
      while(Date.now()<end){
        const main=await httpJson(17891,'/api/health?_supervisor='+Date.now(),1500);
        const revenue=await httpJson(17893,'/health?_supervisor='+Date.now(),1500);
        const yaziciMeta=readJson(path.join(proRoot,'YaziciPRO','yazici-pro-version.json'))||{};
        const yaziciExpectedVersion=String(yaziciMeta.version||'').trim();
        const mainOk=Boolean(yaziciExpectedVersion)&&main.ok&&main.json&&main.json.ok===true&&String(main.json.version||'')===yaziciExpectedVersion;
        const revenueOk=Boolean(yaziciExpectedVersion)&&revenue.ok&&revenue.json&&revenue.json.ok===true&&String(revenue.json.version||'')===yaziciExpectedVersion;
        if(mainOk&&revenueOk){ yazici={ok:true,details:'17891+17893 health/version OK'}; break; }
        yazici={ok:false,details:JSON.stringify({main:main.json||null,revenue:revenue.json||null})};
        await sleep(250);
      }
      if(!yazici.ok){
        const logDir=path.join(process.env.LOCALAPPDATA||'', 'KafePinYaziciPRO','logs');
        const tails=[];
        for(const f of ['yazici-startup.log','yazici-revenue.err.log','yazici-webservice.err.log']){
          try{ const lines=fs.readFileSync(path.join(logDir,f),'utf8').split(/\\r?\\n/).filter(Boolean); tails.push(`${f}: ${lines.slice(-12).join(' | ')}`); }catch(_){ tails.push(`${f}: okunamadi`); }
        }
        throw new Error(`Yazici PRO 17891/17893 health veya version dogrulamasi basarisiz: ${yazici.details}; ${tails.join(' || ')}`);
      }
      log(installRoot,'component-only Yazici PRO health/version verified: '+yazici.details);
    } else {
      shell=await ensureDesktopShellExact(installRoot);
      mp3=syncMp3Payload(installRoot,proRoot); await startAndVerifyMp3(mp3);
      componentsSynced=syncPackagedProComponents(installRoot);
      if(componentsSynced){ await runDesktopBridgeAction(installRoot,'refresh-pro-services',70000); proServicesRefreshed=true; }
    }
    const desktopLaunched=!desktopWasRunning || shell.required;
"""
    if text.count(old) != 1:
        raise SystemExit(f'supervisor activation anchor mismatch: {text.count(old)}')
    return text.replace(old, new, 1)
'''
one("\ndef main() -> None:\n", insert + "\ndef main() -> None:\n", 'insert patch_supervisor')

one("        nested_bytes = outer.read(NESTED)\n", "        nested_bytes = outer.read(NESTED)\n        supervisor_bytes = outer.read(SUPERVISOR)\n        patched_supervisor = patch_supervisor(supervisor_bytes.decode('utf-8-sig')).encode('utf-8')\n", 'supervisor bytes')

one("                yz.extractall(td)\n", "                for info in yz.infolist():\n                    if info.is_dir() or info.filename not in ALLOWED_YAZICI: continue\n                    dest = td / Path(info.filename)\n                    dest.parent.mkdir(parents=True, exist_ok=True)\n                    dest.write_bytes(yz.read(info.filename))\n", 'targeted extract permissions')

one("            changed = {name for name, old in before.items() if (td / Path(name)).read_bytes() != old}\n", "            changed = {name for name, old in before.items() if name in ALLOWED_YAZICI and (td / Path(name)).read_bytes() != old}\n", 'targeted change comparison')

one("            update['buildRevision'] = 'v403-candidate-edevlet-r1'", "            update['buildRevision'] = 'v403-candidate3-edevlet-fast-r3'\n            update['files'] = [SUPERVISOR, NESTED]", 'candidate metadata')

one("                'v4.0.3 TEST/CANDIDATE: v4.0.2 STABLE güncelleme/rollback/DB güvenliği aynen korunur; yalnız Yazıcı PRO içine e-Devlet Resmî Belgeler testi eklenir.',", "                'v4.0.3 TEST/CANDIDATE2: hedefli hızlı güncelleme; ana masaüstü kabuğu ve diğer PRO modülleri refresh edilmez, yalnız Yazıcı PRO güncellenir.',\n                'v4.0.3 TEST/CANDIDATE: v4.0.2 STABLE güncelleme/rollback/DB güvenliği aynen korunur; yalnız Yazıcı PRO içine e-Devlet Resmî Belgeler testi eklenir.',", 'candidate note')

one("                    elif info.filename == NESTED:\n                        data = patched_nested\n                    outz.writestr(info, data)", "                    elif info.filename == NESTED:\n                        data = patched_nested\n                    elif info.filename == SUPERVISOR:\n                        data = patched_supervisor\n                    outz.writestr(info, data)", 'outer supervisor write')

one("(root / 'KafePin-Pro-Update-v4.0.3-CANDIDATE.sha256.txt')", "(root / 'KafePin-Pro-Update-v4.0.3-CANDIDATE3.sha256.txt')", 'sha filename')
one("- Outer değişen girdiler: `update.json`, `pro-components/yazici-pro.zip`", "- Outer değişen girdiler: `update.json`, `KafePin_Update_Supervisor.js`, `pro-components/yazici-pro.zip`\n- Hızlı component-only aktivasyon: desktop shell exact/rebuild ve diğer PRO refresh adımları atlanır; yalnız Yazıcı PRO repair edilir.\n- `update.json files` yalnız `KafePin_Update_Supervisor.js` + `pro-components/yazici-pro.zip`; ana program dosyaları kopyalanmaz.", 'report outer')

p.write_text(s, encoding='utf-8')
print('CANDIDATE3_PATCH_OK')
