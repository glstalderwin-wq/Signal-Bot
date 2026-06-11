import { useState, useRef, useCallback } from "react";

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const API_KEY  = "ebb5006f08044439b94cc2d839102a3e";
const MARKETS  = [
  { symbol: "EURUSD", label: "EUR/USD", type: "Forex",     dec: 5, td: "EUR/USD" },
  { symbol: "GBPUSD", label: "GBP/USD", type: "Forex",     dec: 5, td: "GBP/USD" },
  { symbol: "XAUUSD", label: "Gold",    type: "Commodity", dec: 2, td: "XAU/USD" },
];
const TF_MAP = { M5:"5min", M15:"15min", H1:"1h", H4:"4h" };

// ─── MATH ─────────────────────────────────────────────────────────────────────
const sma = (arr, n) => arr.slice(-n).reduce((a,b)=>a+b,0)/n;

function ema(arr, n) {
  if (arr.length < n) return arr[arr.length-1];
  const k = 2/(n+1);
  let e = sma(arr.slice(0, n), n);
  for (let i = n; i < arr.length; i++) e = arr[i]*k + e*(1-k);
  return e;
}

function rsi(closes, n=14) {
  if (closes.length < n+1) return 50;
  let g=0, l=0;
  for (let i = closes.length-n; i < closes.length; i++) {
    const d = closes[i]-closes[i-1];
    d>0 ? g+=d : l+=Math.abs(d);
  }
  return l===0 ? 100 : 100-100/(1+g/l);
}

function macdDir(closes) {
  // Simple: is EMA12 above or below EMA26?
  if (closes.length < 27) return "neutral";
  const e12 = ema(closes, 12);
  const e26 = ema(closes, 26);
  return e12 > e26 ? "bull" : "bear";
}

function atr(candles) {
  if (candles.length < 2) return 0.001;
  return candles.slice(-14).reduce((sum, c, i, arr) => {
    if (i===0) return sum + (c.h-c.l);
    return sum + Math.max(c.h-c.l, Math.abs(c.h-arr[i-1].c), Math.abs(c.l-arr[i-1].c));
  }, 0) / Math.min(14, candles.length);
}

function pattern(candles) {
  if (candles.length < 2) return null;
  const c = candles[candles.length-1];
  const p = candles[candles.length-2];
  const cb = Math.abs(c.c-c.o), pb = Math.abs(p.c-p.o);
  const wT = c.h - Math.max(c.o,c.c);
  const wB = Math.min(c.o,c.c) - c.l;
  if (c.c>c.o && p.c<p.o && cb>pb*0.8) return "bull";
  if (c.c<c.o && p.c>p.o && cb>pb*0.8) return "bear";
  if (wB > cb*1.5 && wB > wT) return "bull";
  if (wT > cb*1.5 && wT > wB) return "bear";
  return null;
}

// ─── FETCH DIRECT (works outside Claude.ai) ───────────────────────────────────
async function fetchTF(tdSymbol, interval) {
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(tdSymbol)}&interval=${interval}&outputsize=40&apikey=${API_KEY}`;
  try {
    const res  = await fetch(url);
    const data = await res.json();
    if (!data.values || data.status==="error") return null;
    return data.values.reverse().map(v=>({
      o:parseFloat(v.open), h:parseFloat(v.high),
      l:parseFloat(v.low),  c:parseFloat(v.close),
    }));
  } catch { return null; }
}

// ─── ANALYZE ONE MARKET ───────────────────────────────────────────────────────
async function analyzeMarket(market, tf, addLog) {
  const interval = TF_MAP[tf];
  if (!interval) return null;

  addLog(`${market.symbol}: Lade Kerzen (${tf})...`, "INFO");

  // Load entry TF
  const candles = await fetchTF(market.td, interval);
  if (!candles) { addLog(`${market.symbol}: Datenfehler`, "WARN"); return null; }

  const closes = candles.map(c=>c.c);
  const price  = closes[closes.length-1];
  const R      = rsi(closes);
  const M      = macdDir(closes);
  const e20    = ema(closes, 20);
  const e50    = ema(closes, Math.min(50, closes.length-1));
  const A      = atr(candles);
  const P      = pattern(candles);

  addLog(`${market.symbol}: RSI=${R.toFixed(0)} MACD=${M} EMA20>${e20.toFixed(market.dec)} EMA50=${e50.toFixed(market.dec)}`, "INFO");

  // Score
  let long=0, short=0, reasons=[];

  if (R < 35)           { long  += 30; reasons.push(`RSI ${R.toFixed(0)} oversold`); }
  else if (R < 45)      { long  += 15; }
  if (R > 65)           { short += 30; reasons.push(`RSI ${R.toFixed(0)} overbought`); }
  else if (R > 55)      { short += 15; }

  if (M==="bull")       { long  += 25; reasons.push("MACD bullish"); }
  else                  { short += 25; reasons.push("MACD bearish"); }

  if (e20 > e50)        { long  += 25; reasons.push("EMA20 > EMA50"); }
  else                  { short += 25; reasons.push("EMA20 < EMA50"); }

  if (price > e50)      { long  += 10; }
  else                  { short += 10; }

  if (P==="bull")       { long  += 10; reasons.push("🕯 Bullish pattern"); }
  if (P==="bear")       { short += 10; reasons.push("🕯 Bearish pattern"); }

  const dir      = long > short ? "LONG" : "SHORT";
  const score    = Math.max(long, short);
  const strength = Math.min(score, 95);
  const sl       = A * 1.2;
  const tp       = A * 2.0;

  return {
    symbol:     market.symbol,
    label:      market.label,
    type:       market.type,
    dec:        market.dec,
    direction:  dir,
    strength,
    entry:      price,
    tp:         dir==="LONG" ? price+tp : price-tp,
    sl:         dir==="LONG" ? price-sl : price+sl,
    rr:         (tp/sl).toFixed(1),
    reasons:    reasons.slice(0,4),
    rsi:        R.toFixed(0),
    macd:       M,
    ema:        e20>e50?"above":"below",
    pattern:    P,
    tf,
  };
}

// ─── STYLES ───────────────────────────────────────────────────────────────────
const S = `
  @import url('https://fonts.googleapis.com/css2?family=Share+Tech+Mono&family=Barlow:wght@400;700;800;900&display=swap');
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
  :root{
    --bg:#05080f;--s1:#090e1a;--s2:#0c1422;--brd:#162035;--brd2:#1e2f4a;
    --acc:#00c8ff;--acc2:#6e44ff;--L:#00e57a;--Sh:#ff3d5a;--W:#ffb300;
    --txt:#d8eaf8;--mu:#3a5470;--mu2:#5a7898;
  }
  body{background:var(--bg);color:var(--txt);font-family:'Barlow',sans-serif;}
  .app{min-height:100vh;padding:18px;position:relative;}
  .bgGrid{position:fixed;inset:0;pointer-events:none;z-index:0;
    background-image:linear-gradient(rgba(0,200,255,.025) 1px,transparent 1px),
    linear-gradient(90deg,rgba(0,200,255,.025) 1px,transparent 1px);
    background-size:32px 32px;}
  .wrap{position:relative;z-index:1;max-width:900px;margin:0 auto;}

  /* Header */
  .hdr{display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;flex-wrap:wrap;gap:10px;}
  .brand{display:flex;align-items:center;gap:12px;}
  .bico{width:44px;height:44px;border:1px solid var(--acc);display:grid;place-items:center;
    clip-path:polygon(50% 0%,100% 25%,100% 75%,50% 100%,0% 75%,0% 25%);
    background:linear-gradient(135deg,var(--s2),var(--bg));font-size:20px;}
  .bname{font-size:22px;font-weight:900;letter-spacing:-1px;}
  .bname em{color:var(--acc);font-style:normal;}
  .btag{font-family:'Share Tech Mono',monospace;font-size:9px;color:var(--mu2);letter-spacing:3px;margin-top:2px;}
  .clk{font-family:'Share Tech Mono',monospace;font-size:12px;color:var(--mu2);}

  /* Controls */
  .ctrl{display:flex;align-items:center;gap:8px;margin-bottom:16px;flex-wrap:wrap;}
  .lbl{font-family:'Share Tech Mono',monospace;font-size:10px;color:var(--mu);letter-spacing:2px;}
  .tfBtn{padding:6px 14px;font-family:'Share Tech Mono',monospace;font-size:11px;
    border:1px solid var(--brd);background:var(--s1);color:var(--mu);cursor:pointer;letter-spacing:1px;}
  .tfBtn.on{border-color:var(--acc);color:var(--acc);background:rgba(0,200,255,.08);}
  .scanBtn{margin-left:auto;padding:8px 22px;font-family:'Share Tech Mono',monospace;font-size:12px;
    letter-spacing:2px;border:1px solid var(--acc);background:transparent;color:var(--acc);
    cursor:pointer;display:flex;align-items:center;gap:8px;transition:all .2s;}
  .scanBtn:hover{background:rgba(0,200,255,.1);}
  .scanBtn:disabled{opacity:.5;pointer-events:none;}
  .spin{display:inline-block;animation:rot 1s linear infinite;}
  @keyframes rot{to{transform:rotate(360deg)}}

  /* Status */
  .status{padding:10px 14px;margin-bottom:16px;font-family:'Share Tech Mono',monospace;
    font-size:11px;border-left:3px solid var(--acc2);background:var(--s1);color:var(--mu2);}

  /* Stats row */
  .stats{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:16px;}
  .stat{background:var(--s1);border:1px solid var(--brd);padding:12px 14px;position:relative;}
  .stat::after{content:'';position:absolute;bottom:0;left:0;right:0;height:2px;
    background:linear-gradient(90deg,var(--acc2),var(--acc));}
  .stl{font-family:'Share Tech Mono',monospace;font-size:9px;color:var(--mu);letter-spacing:2px;margin-bottom:6px;}
  .stv{font-size:26px;font-weight:900;}
  .stv.L{color:var(--L);}.stv.S{color:var(--Sh);}.stv.A{color:var(--acc);}.stv.W{color:var(--W);}

  /* Cards */
  .cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px;}
  .card{background:var(--s1);border:1px solid var(--brd);padding:16px;transition:all .2s;}
  .card.cL{border-color:rgba(0,229,122,.4);box-shadow:0 0 20px rgba(0,229,122,.15);}
  .card.cS{border-color:rgba(255,61,90,.4);box-shadow:0 0 20px rgba(255,61,90,.15);}
  .card.cL::before,.card.cS::before{content:'';display:block;height:2px;margin:-16px -16px 12px;}
  .card.cL::before{background:var(--L);}.card.cS::before{background:var(--Sh);}

  .ch{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px;}
  .csym{font-size:20px;font-weight:900;}
  .cmeta{font-family:'Share Tech Mono',monospace;font-size:9px;color:var(--mu);letter-spacing:2px;margin-top:2px;}
  .sig{padding:5px 12px;font-weight:800;font-size:12px;letter-spacing:1.5px;display:flex;align-items:center;gap:5px;}
  .sig.L{background:rgba(0,229,122,.12);border:1px solid rgba(0,229,122,.4);color:var(--L);}
  .sig.S{background:rgba(255,61,90,.12);border:1px solid rgba(255,61,90,.4);color:var(--Sh);}

  .price{font-family:'Share Tech Mono',monospace;font-size:11px;color:var(--acc);margin-bottom:10px;}

  .strRow{display:flex;justify-content:space-between;font-family:'Share Tech Mono',monospace;
    font-size:9px;color:var(--mu);letter-spacing:1px;margin-bottom:4px;}
  .strBar{height:3px;background:var(--brd);margin-bottom:12px;}
  .strFill{height:100%;}
  .strFill.L{background:linear-gradient(90deg,#00a855,var(--L));}
  .strFill.S{background:linear-gradient(90deg,#a0002a,var(--Sh));}

  .lvls{display:grid;grid-template-columns:1fr 1fr 1fr;gap:5px;margin-bottom:10px;}
  .lv{background:var(--s2);border:1px solid var(--brd);padding:7px 9px;}
  .ll{font-family:'Share Tech Mono',monospace;font-size:7px;color:var(--mu);letter-spacing:1px;margin-bottom:3px;}
  .lval{font-size:12px;font-weight:700;}
  .lv.en .lval{color:var(--txt);}.lv.tp .lval{color:var(--L);}.lv.sl .lval{color:var(--Sh);}

  .chips{display:flex;gap:5px;flex-wrap:wrap;margin-bottom:10px;}
  .chip{font-family:'Share Tech Mono',monospace;font-size:8px;padding:3px 8px;
    border:1px solid var(--brd);color:var(--mu);background:var(--s2);}
  .chip.bull{color:var(--L);border-color:rgba(0,229,122,.3);}
  .chip.bear{color:var(--Sh);border-color:rgba(255,61,90,.3);}
  .chip.warn{color:var(--W);border-color:rgba(255,179,0,.3);}

  .reasons{border-top:1px solid var(--brd);padding-top:8px;display:flex;flex-direction:column;gap:3px;}
  .rsn{font-size:11px;color:var(--mu2);display:flex;align-items:center;gap:5px;}
  .rsn::before{content:'›';color:var(--acc2);}

  /* Empty state */
  .empty{text-align:center;padding:40px 20px;font-family:'Share Tech Mono',monospace;color:var(--mu);font-size:12px;letter-spacing:2px;}

  /* Log */
  .log{margin-top:16px;background:var(--s1);border:1px solid var(--brd);padding:12px 14px;}
  .loghdr{font-family:'Share Tech Mono',monospace;font-size:9px;color:var(--mu);letter-spacing:3px;margin-bottom:8px;}
  .logbody{max-height:130px;overflow-y:auto;display:flex;flex-direction:column;gap:1px;}
  .logline{display:flex;gap:8px;font-family:'Share Tech Mono',monospace;font-size:9px;
    padding:3px 0;border-bottom:1px solid rgba(22,32,53,.5);}
  .logt{color:var(--mu);min-width:65px;}
  .logm{flex:1;}
  .logm.INFO{color:var(--acc);}.logm.LONG{color:var(--L);}.logm.SHORT{color:var(--Sh);}
  .logm.WARN{color:var(--W);}.logm.GREY{color:var(--mu2);}
  ::-webkit-scrollbar{width:2px;}::-webkit-scrollbar-thumb{background:var(--brd2);}
  @media(max-width:500px){.stats{grid-template-columns:repeat(2,1fr);}.cards{grid-template-columns:1fr;}}
`;

// ─── APP ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [tf, setTf]           = useState("H1");
  const [results, setResults] = useState([]);
  const [scanning, setScanning] = useState(false);
  const [log, setLog]         = useState([{ t:"--:--:--", m:"Bot bereit — drücke SCAN zum Starten", type:"GREY" }]);
  const [scanned, setScanned] = useState(false);
  const logRef = useRef(null);

  const addLog = useCallback((msg, type="INFO") => {
    const t = new Date().toLocaleTimeString("de-DE");
    setLog(p => {
      const next = [...p.slice(-60), { t, m: msg, type }];
      return next;
    });
    setTimeout(() => { if(logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, 50);
  }, []);

  const scan = useCallback(async () => {
    setScanning(true);
    setResults([]);
    setScanned(false);
    addLog(`Scan gestartet — ${tf} — ${MARKETS.length} Märkte`, "INFO");

    const out = [];
    for (const market of MARKETS) {
      try {
        const result = await analyzeMarket(market, tf, addLog);
        if (result) {
          out.push(result);
          addLog(`${market.symbol}: ${result.direction} ${result.strength}% RR 1:${result.rr}`, result.direction);
        }
      } catch(e) {
        addLog(`${market.symbol}: Fehler — ${e.message}`, "WARN");
      }
      // Warte 8 Sekunden zwischen Märkten → max 7 req/min → Free Plan sicher
      if (MARKETS.indexOf(market) < MARKETS.length - 1) {
        addLog(`Warte 8s (Rate Limit)...`, "GREY");
        await new Promise(r => setTimeout(r, 8000));
      }
    }

    setResults(out);
    setScanned(true);
    setScanning(false);
    addLog(`Scan fertig — ${out.length}/${MARKETS.length} Signale gefunden ✅`, "INFO");
  }, [tf, addLog]);

  const fmt = (v, d) => v?.toFixed(d) ?? "—";
  const longs  = results.filter(r=>r.direction==="LONG").length;
  const shorts = results.filter(r=>r.direction==="SHORT").length;
  const avgStr = results.length ? Math.round(results.reduce((a,r)=>a+r.strength,0)/results.length) : 0;
  const avgRR  = results.length ? (results.reduce((a,r)=>a+parseFloat(r.rr),0)/results.length).toFixed(1) : "—";

  return (
    <>
      <style>{S}</style>
      <div className="app">
        <div className="bgGrid"/>
        <div className="wrap">

          {/* Header */}
          <div className="hdr">
            <div className="brand">
              <div className="bico">📡</div>
              <div>
                <div className="bname">SIGNAL<em>BOT</em></div>
                <div className="btag">MT5 · EURUSD · GBPUSD · XAUUSD</div>
              </div>
            </div>
            <div className="clk">{new Date().toLocaleTimeString("de-DE")}</div>
          </div>

          {/* Controls */}
          <div className="ctrl">
            <span className="lbl">TF:</span>
            {Object.keys(TF_MAP).map(t => (
              <button key={t} className={`tfBtn ${tf===t?"on":""}`} onClick={()=>setTf(t)} disabled={scanning}>{t}</button>
            ))}
            <button className="scanBtn" onClick={scan} disabled={scanning}>
              {scanning ? <><span className="spin">⟳</span> SCANNING...</> : "⟳ SCAN"}
            </button>
          </div>

          {/* Status */}
          <div className="status">
            {scanning
              ? `⏳ Lade Kerzen... (ca. ${MARKETS.length * 8}s wegen Rate Limit)`
              : scanned
              ? `✅ Letzter Scan: ${new Date().toLocaleTimeString("de-DE")} — ${results.length} Signale auf ${tf}`
              : "👆 Drücke SCAN um Signale zu laden"}
          </div>

          {/* Stats */}
          {scanned && (
            <div className="stats">
              <div className="stat"><div className="stl">LONG</div><div className="stv L">{longs}</div></div>
              <div className="stat"><div className="stl">SHORT</div><div className="stv S">{shorts}</div></div>
              <div className="stat"><div className="stl">AVG STRENGTH</div><div className="stv A">{avgStr}%</div></div>
              <div className="stat"><div className="stl">AVG R:R</div><div className="stv W">1:{avgRR}</div></div>
            </div>
          )}

          {/* Cards */}
          <div className="cards">
            {results.map(r => (
              <div key={r.symbol} className={`card c${r.direction==="LONG"?"L":"S"}`}>
                <div className="ch">
                  <div>
                    <div className="csym">{r.symbol}</div>
                    <div className="cmeta">{r.type} · {r.tf}</div>
                  </div>
                  <div className={`sig ${r.direction==="LONG"?"L":"S"}`}>
                    {r.direction==="LONG"?"▲":"▼"} {r.direction}
                  </div>
                </div>

                <div className="price">@ {fmt(r.entry, r.dec)}</div>

                <div className="strRow">
                  <span>SIGNAL STRENGTH</span>
                  <span style={{color:r.direction==="LONG"?"var(--L)":"var(--Sh)"}}>{r.strength}%</span>
                </div>
                <div className="strBar">
                  <div className={`strFill ${r.direction==="LONG"?"L":"S"}`} style={{width:`${r.strength}%`}}/>
                </div>

                <div className="lvls">
                  <div className="lv en"><div className="ll">ENTRY</div><div className="lval">{fmt(r.entry,r.dec)}</div></div>
                  <div className="lv tp"><div className="ll">TAKE PROFIT</div><div className="lval">{fmt(r.tp,r.dec)}</div></div>
                  <div className="lv sl"><div className="ll">STOP LOSS</div><div className="lval">{fmt(r.sl,r.dec)}</div></div>
                </div>

                <div className="chips">
                  <div className={`chip ${r.rsi<40?"bull":r.rsi>60?"bear":""}`}>RSI {r.rsi}</div>
                  <div className={`chip ${r.macd==="bull"?"bull":"bear"}`}>MACD {r.macd==="bull"?"BULL":"BEAR"}</div>
                  <div className={`chip ${r.ema==="above"?"bull":"bear"}`}>EMA {r.ema==="above"?"BULL":"BEAR"}</div>
                  {r.pattern && <div className="chip warn">{r.pattern==="bull"?"🕯 BULL":"🕯 BEAR"}</div>}
                  <div className="chip">R:R 1:{r.rr}</div>
                </div>

                <div className="reasons">
                  {r.reasons.map((x,i)=><div key={i} className="rsn">{x}</div>)}
                </div>
              </div>
            ))}

            {scanned && results.length===0 && (
              <div className="empty">
                KEINE SIGNALE AUF {tf}<br/>
                <span style={{fontSize:10,opacity:.6,marginTop:8,display:"block"}}>
                  Markt konsolidiert — anderen TF versuchen
                </span>
              </div>
            )}
          </div>

          {/* Log */}
          <div className="log">
            <div className="loghdr">▸ LOG</div>
            <div className="logbody" ref={logRef}>
              {log.map((e,i)=>(
                <div key={i} className="logline">
                  <span className="logt">{e.t}</span>
                  <span className={`logm ${e.type}`}>{e.m}</span>
                </div>
              ))}
            </div>
          </div>

        </div>
      </div>
    </>
  );
}
