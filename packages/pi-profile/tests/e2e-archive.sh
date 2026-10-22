#!/usr/bin/env bash
# End-to-end proof for the session archive: the real CLI and the real pi,
# against a private temp root below this checkout. Run: bash tests/e2e-archive.sh
set -u
# Every check prints yes or NO (a leak prints YES (leak)). Run the checks
# with their output copied to a file, then exit 1 if any check failed.
if [ -z "${E2E_ARCHIVE_INNER:-}" ]; then
  LOG=$(mktemp)
  E2E_ARCHIVE_INNER=1 bash "$0" "$@" 2>&1 | tee "$LOG"
  if grep -Eq '(^|[^A-Za-z])NO([^A-Za-z]|$)|YES \(leak\)' "$LOG"; then rm -f -- "$LOG"; echo "e2e: a check failed" >&2; exit 1; fi
  rm -f -- "$LOG"; echo "e2e: every check passed"; exit 0
fi
ROOT=$(mktemp -d "$PWD/.e2e-archive-XXXXXX")
case "$ROOT" in "$PWD"/.e2e-archive-*) ;; *) echo "bad root $ROOT"; exit 2;; esac
trap 'rm -rf -- "$ROOT"' EXIT
export PI_PROFILE_HOME="$ROOT/pi" PI_CODING_AGENT_DIR="$ROOT/pi/agent" PI_PROFILE_HOST_ID=e2ehost PI_PROFILE_NO_GLOBAL_DEFAULT=1 HOME="$ROOT/home"
mkdir -p "$ROOT/work/proj" "$PI_CODING_AGENT_DIR/sessions/--work-proj--" "$ROOT/archive" "$HOME" "$PI_PROFILE_HOME/pi-profile"
REPO=$PWD
CLI="node $REPO/bin/pi-profile.mjs"
S="$PI_CODING_AGENT_DIR/sessions/--work-proj--"
node -e '
const fs=require("fs");const d=process.argv[1];const t0=Date.now()-40*864e5;
const mk=(id,prompts,name)=>{const L=[{type:"session",version:3,id,timestamp:new Date(t0).toISOString(),cwd:process.argv[2]}];let p=null,n=0;
const add=(e,at)=>{const i=(++n).toString(16).padStart(8,"0");L.push({...e,id:i,parentId:p,timestamp:new Date(at).toISOString()});p=i;};
add({type:"thinking_level_change",thinkingLevel:"off"},t0);
prompts.forEach((q,k)=>{const at=t0+(k+1)*6e4;add({type:"message",message:{role:"user",content:[{type:"text",text:q}],timestamp:at}},at);add({type:"message",message:{role:"assistant",content:[{type:"text",text:"ok "+q}],timestamp:at+1}},at+1);});
if(name)add({type:"session_info",name},t0+1);return L.map(x=>JSON.stringify(x)).join("\n")+"\n";};
for(const [f,id,age] of [["old-a.jsonl","11111111-aaaa",40],["old-b.jsonl","22222222-bbbb",40],["young.jsonl","33333333-cccc",3],["locked.jsonl","44444444-dddd",40]]){
 const p=d+"/"+f;fs.writeFileSync(p,mk(id,["first prompt of "+id,"middle","last prompt of "+id],"name "+id));const t=(Date.now()-age*864e5)/1e3;fs.utimesSync(p,t,t);}
fs.writeFileSync(d+"/locked.jsonl.pi-daemon.lock","{}");' "$S" "$ROOT/work/proj"
cat > "$PI_PROFILE_HOME/pi-profile/config.json" <<EOF
{"schemaVersion":1,"hostId":"e2ehost","sessionStores":{},"archive":{"store":{"kind":"local","path":"$ROOT/archive"},"keepLocalDays":0}}
EOF
sha() { sha256sum "$1" | cut -c1-16; }
A0=$(sha "$S/old-a.jsonl"); B0=$(sha "$S/old-b.jsonl")
echo "== 1. dry run"; $CLI sessions archive; echo "exit $?"
echo "   archive folder after dry run: $(ls -A "$ROOT/archive" | wc -l) entries; old-a unchanged: $([ "$(sha "$S/old-a.jsonl")" = "$A0" ] && echo yes)"
echo "== 2. apply"; $CLI sessions archive --apply 2>&1; echo "exit $?"
ls -la "$S" | awk '{print $5, $9}' | tail -n +4
echo "   archive files:"; (cd "$ROOT/archive" && find . -type f | sort)
echo "== 3. /resume listing (Pi's own SessionManager.list on the store)"
node --input-type=module -e '
import { SessionManager } from "@earendil-works/pi-coding-agent";
const l = await SessionManager.list(process.argv[2], process.argv[1]);
for (const s of l) console.log("  ", s.id, "|", s.name, "|", s.firstMessage, "|", s.modified.toISOString().slice(0,10), "|", s.messageCount, "msgs");' "$S" "$ROOT/work/proj"
echo "== 4. the real pi on a stub, at startup (no model configured, so no turn runs)"
cd "$ROOT"; STUB0=$(sha "$S/old-a.jsonl")
PI_OFFLINE=1 pi --export "$S/old-a.jsonl" "$ROOT/a.html" >/dev/null 2>&1; echo "   pi --export exit $?"
node -e 'const h=require("fs").readFileSync(process.argv[1],"utf8");const m=h.match(/id="session-data" type="application\/json">([^<]*)</);const d=m?Buffer.from(m[1].trim(),"base64").toString("utf8"):"";console.log("   pi shows: first prompt", d.includes("first prompt of 11111111")?"yes":"NO", "| restore notice", d.includes("pi-profile sessions restore 11111111-aaaa")?"yes":"NO", "| middle prompt", d.includes("\"middle\"")?"YES (leak)":"no")' "$ROOT/a.html"
PI_OFFLINE=1 timeout 30 pi --no-extensions --session "$S/old-a.jsonl" -p hi >/dev/null 2>&1; echo "   pi --session FILE -p exit $?; stub unchanged: $([ "$(sha "$S/old-a.jsonl")" = "$STUB0" ] && echo yes || echo NO)"
PI_OFFLINE=1 timeout 30 pi --no-extensions --session 11111111 -p hi >/dev/null 2>&1; echo "   pi --session ID -p exit $?; stub unchanged: $([ "$(sha "$S/old-a.jsonl")" = "$STUB0" ] && echo yes || echo NO)"
PI_OFFLINE=1 timeout 30 pi --no-extensions --fork 11111111 -p hi >/dev/null 2>&1; echo "   pi --fork ID -p exit $?"
F=$(ls -t "$PI_CODING_AGENT_DIR/sessions"/*/ 2>/dev/null | head -0); node -e 'const fs=require("fs"),p=require("path");const root=process.argv[1];for(const d of fs.readdirSync(root)){for(const f of fs.readdirSync(p.join(root,d))){const t=fs.readFileSync(p.join(root,d,f),"utf8");const h=JSON.parse(t.split("\n")[0]||"{}");if(t.includes("pi-profile/archived")&&h.id!=="11111111-aaaa"&&h.id!=="22222222-bbbb")console.log("   fork written:", d+"/"+f.slice(0,12)+"…", "carries notice of 11111111-aaaa:", t.includes("\"sessionId\":\"11111111-aaaa\""));}}' "$PI_CODING_AGENT_DIR/sessions" 2>/dev/null
echo "   with the pi-profile extension loaded (rpc mode): session_start notices"
echo "   (pi -c picks the newest file by mtime; the stub keeps the session's old mtime, so -c opens it only when it is the newest)"
mkdir -p "$ROOT/only"; cp -p "$S/old-a.jsonl" "$ROOT/only/"; cd "$ROOT/work/proj"
for ARG in "--session $S/old-a.jsonl" "--fork 11111111" "--session-dir $S -c" "--session-dir $ROOT/only -c"; do
  printf '%s\n' '{"type":"get_state","id":"1"}' | PI_OFFLINE=1 timeout 20 pi --no-extensions -e "$REPO/src/index.ts" $ARG --mode rpc 2>/dev/null | node -e 'let b="";process.stdin.on("data",c=>b+=c).on("end",()=>{const n=b.split("\n").filter(l=>l.includes("archive:")).map(l=>{try{const j=JSON.parse(l);return (j.message??j.text??JSON.stringify(j)).slice(0,110)}catch{return l.slice(0,110)}});console.log("     pi '"$(echo $ARG | sed "s#$ROOT/##g")"':", n.length? n.join(" / ") : "(no archive notice)")})'
done
cd "$REPO"
echo "== 5. restore by id"; $CLI sessions restore 11111111; echo "exit $?"
echo "   old-a byte-identical: $([ "$(sha "$S/old-a.jsonl")" = "$A0" ] && echo yes || echo NO)"
echo "== 6. stub with new lines"
echo '{"type":"message","id":"zz","parentId":null,"timestamp":"2026-10-21T00:00:00.000Z","message":{"role":"user","content":"added after archive","timestamp":1}}' >> "$S/old-b.jsonl"
G=$(sha "$S/old-b.jsonl")
$CLI sessions restore "$S/old-b.jsonl"; echo "exit $?"
echo "   grown stub untouched: $([ "$(sha "$S/old-b.jsonl")" = "$G" ] && echo yes || echo NO)"
K=$(ls "$S" | grep "^old-b.kept-"); echo "   kept copy: $K byte-identical to original: $([ "$(sha "$S/$K")" = "$B0" ] && echo yes || echo NO)"
echo "== 7. manifest (one entry)"
node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1]));for(const [k,v] of Object.entries(m.sessions))console.log("  ",k,JSON.stringify(v).slice(0,400))' "$PI_CODING_AGENT_DIR/sessions/.pi-profile-archive.json"
echo "== 8. schedule"; $CLI sessions archive --install-schedule; (cd "$HOME" && find . -type f | sort)
