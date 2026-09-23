/**
 * The embedding service's front door — a small Node script run inside its own
 * container (`node -e`, like the doorman), between the agents and the
 * llama.cpp server. Its own process on purpose: the control plane restarts on
 * every deploy, and memory search must not pause when it does
 * (docs/embedder-and-openclaw-port-design.md).
 *
 * What it does, and all it does:
 * - accepts `POST /v1/embeddings` with `Authorization: Bearer <an agent's
 *   embed key>`; the keys are a file Hatchabot writes (sha256 → agent id),
 *   re-read when it changes, so a rebuild re-mints without a restart;
 * - rate-limits per agent (a token bucket, EMBED_PER_MIN a minute), caps the
 *   body at 2 MB and the inputs at 256, times out at 60 s;
 * - forwards the body unchanged to the server with the server's own key and
 *   returns the answer as it came;
 * - `GET /health` answers for the server behind it.
 * It never logs or stores a request body — they are people's memories. One
 * line per call: agent id, input count, bytes, milliseconds, status.
 */
export function doorScript(): string {
  return [
    'const http=require("http"),crypto=require("crypto"),fs=require("fs");',
    'const UP=(process.env.EMBED_UPSTREAM||"http://embedder:8080").replace(/\\/$/,"");',
    'const UPKEYFILE=process.env.EMBED_SERVER_KEY_FILE||"";',
    'function upkey(){try{return UPKEYFILE?fs.readFileSync(UPKEYFILE,"utf8").trim():(process.env.EMBED_UPSTREAM_KEY||"");}catch(e){return process.env.EMBED_UPSTREAM_KEY||"";}}',
    'const MAX_INFLIGHT_AGENT=Number(process.env.EMBED_MAX_INFLIGHT_AGENT||4),MAX_INFLIGHT=Number(process.env.EMBED_MAX_INFLIGHT||32);',
    'let inflight=0;const inflightBy=new Map();',
    'const KEYS=process.env.EMBED_KEYS_FILE||"/keys/embed-keys.json";',
    'const PER_MIN=Number(process.env.EMBED_PER_MIN||600);',
    'const KEYS_TTL=Number(process.env.EMBED_KEYS_TTL_MS||2000);',
    'const MAX_BODY=2*1024*1024,MAX_INPUTS=256,TIMEOUT=60000;',
    'let keys={},keysMtime=-1,keysAt=0;',
    'function loadKeys(){const now=Date.now();if(now-keysAt<KEYS_TTL)return;keysAt=now;',
    ' try{const st=fs.statSync(KEYS);if(st.mtimeMs===keysMtime)return;keysMtime=st.mtimeMs;',
    '  const j=JSON.parse(fs.readFileSync(KEYS,"utf8"));keys=(j&&typeof j==="object")?j:{};}catch(e){keys={};}}',
    'const buckets=new Map();',
    'function allow(agent){const now=Date.now();let b=buckets.get(agent);if(!b){b={t:PER_MIN,at:now};buckets.set(agent,b);}',
    ' b.t=Math.min(PER_MIN,b.t+(now-b.at)*PER_MIN/60000);b.at=now;if(b.t<1)return false;b.t-=1;return true;}',
    'function send(res,code,obj){res.writeHead(code,{"content-type":"application/json"});res.end(JSON.stringify(obj));}',
    'const server=http.createServer((req,res)=>{',
    ' if(req.method==="GET"&&req.url==="/health"){',
    '  fetch(UP+"/health",{signal:AbortSignal.timeout(5000)}).then(r=>send(res,r.ok?200:503,{ok:r.ok})).catch(()=>send(res,503,{ok:false}));return;}',
    ' if(req.method!=="POST"||req.url!=="/v1/embeddings"){send(res,404,{error:"not found"});return;}',
    ' loadKeys();',
    ' const a=req.headers.authorization||"";const tok=a.startsWith("Bearer ")?a.slice(7):"";',
    ' const agent=tok?keys[crypto.createHash("sha256").update(tok).digest("hex")]:undefined;',
    ' if(!agent){send(res,401,{error:"unauthorized"});req.resume();return;}',
    ' if(!allow(agent)){send(res,429,{error:"rate limited"});req.resume();return;}',
    ' if(inflight>=MAX_INFLIGHT||(inflightBy.get(agent)||0)>=MAX_INFLIGHT_AGENT){send(res,429,{error:"busy"});req.resume();return;}',
    ' inflight++;inflightBy.set(agent,(inflightBy.get(agent)||0)+1);let released=false;',
    ' const release=()=>{if(released)return;released=true;inflight--;inflightBy.set(agent,Math.max(0,(inflightBy.get(agent)||1)-1));};',
    ' res.on("close",release);',
    ' const chunks=[];let size=0,over=false;',
    ' req.on("data",c=>{if(over)return;size+=c.length;if(size>MAX_BODY){over=true;send(res,413,{error:"body too large"});req.destroy();}else chunks.push(c);});',
    ' req.on("error",()=>{});',
    ' req.on("end",async()=>{if(over)return;const started=Date.now();const raw=Buffer.concat(chunks);let n=1;',
    '  try{const j=JSON.parse(raw.toString("utf8"));if(Array.isArray(j.input))n=j.input.length;}catch(e){send(res,400,{error:"bad json"});return;}',
    '  if(n>MAX_INPUTS){send(res,413,{error:"too many inputs"});return;}',
    '  try{const h={"content-type":"application/json"};const k=upkey();if(k)h.authorization="Bearer "+k;',
    '   const r=await fetch(UP+"/v1/embeddings",{method:"POST",headers:h,body:raw,signal:AbortSignal.timeout(TIMEOUT)});',
    '   const body=Buffer.from(await r.arrayBuffer());',
    '   res.writeHead(r.status,{"content-type":r.headers.get("content-type")||"application/json"});res.end(body);',
    '   console.log(JSON.stringify({agent,n,bytes:raw.length,ms:Date.now()-started,status:r.status}));}',
    '  catch(e){send(res,502,{error:"embedder unavailable"});',
    '   console.log(JSON.stringify({agent,n,bytes:raw.length,ms:Date.now()-started,error:String((e&&e.name)||e)}));}',
    ' });',
    '});',
    'server.listen(Number(process.env.EMBED_DOOR_PORT||8093),"0.0.0.0",()=>{console.log(JSON.stringify({listening:server.address().port}));});',
  ].join('\n');
}
