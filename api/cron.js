const TELEGRAM_TOKEN = "8480944386:AAEE_vF6P8csLFMua8-6mpjrW4IGRZT_42g";
const CHAT_ID = "1450916465";
const API_KEY = "ebb5006f08044439b94cc2d839102a3e";

const MARKETS = [
  { symbol: "EURUSD", td: "EUR/USD", dec: 5 },
  { symbol: "GBPUSD", td: "GBP/USD", dec: 5 },
  { symbol: "XAUUSD", td: "XAU/USD", dec: 2 },
];

async function fetchCandles(symbol, interval) {
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=${interval}&outputsize=40&apikey=${API_KEY}`;
  const res = await fetch(url);
  const data = await res.json();
  if (!data.values) return null;
  return data.values.reverse().map(v => ({
    o: parseFloat(v.open), h: parseFloat(v.high),
    l: parseFloat(v.low),  c: parseFloat(v.close),
  }));
}

function calcEMA(arr, n) {
  if (arr.length < n) return arr[arr.length - 1];
  const k = 2 / (n + 1);
  let e = arr.slice(0, n).reduce((a, b) => a + b, 0) / n;
  for (let i = n; i < arr.length; i++) e = arr[i] * k + e * (1 - k);
  return e;
}

function calcRSI(closes, n = 14) {
  if (closes.length < n + 1) return 50;
  let g = 0, l = 0;
  for (let i = closes.length - n; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    d > 0 ? g += d : l += Math.abs(d);
  }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}

async function sendTelegram(message) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT_ID, text: message, parse_mode: "HTML" }),
  });
}

export default async function handler(req, res) {
  const signals = [];

  for (const market of MARKETS) {
    const candles = await fetchCandles(market.td, "1h");
    if (!candles || candles.length < 30) continue;

    const closes = candles.map(c => c.c);
    const price  = closes[closes.length - 1];
    const rsi    = calcRSI(closes);
    const ema20  = calcEMA(closes, 20);
    const ema50  = calcEMA(closes, Math.min(50, closes.length - 1));
    const macd   = calcEMA(closes, 12) > calcEMA(closes, 26) ? "bull" : "bear";

    let long = 0, short = 0;
    if (rsi < 35) long  += 30; else if (rsi < 45) long  += 15;
    if (rsi > 65) short += 30; else if (rsi > 55) short += 15;
    if (macd === "bull") long += 25; else short += 25;
    if (ema20 > ema50)   long += 25; else short += 25;
    if (price > ema50)   long += 10; else short += 10;

    const dir      = long > short ? "LONG" : "SHORT";
    const strength = Math.min(Math.max(long, short), 95);
    const atrVal   = candles.slice(-14).reduce((sum, c, i, arr) => {
      if (i === 0) return sum + (c.h - c.l);
      return sum + Math.max(c.h - c.l, Math.abs(c.h - arr[i-1].c), Math.abs(c.l - arr[i-1].c));
    }, 0) / 14;

    const sl = atrVal * 1.2;
    const tp = atrVal * 2.0;
    const entry  = price;
    const tpVal  = dir === "LONG" ? entry + tp : entry - tp;
    const slVal  = dir === "LONG" ? entry - sl : entry + sl;

    if (strength >= 55) {
      signals.push({ symbol: market.symbol, dir, strength, entry, tp: tpVal, sl: slVal, dec: market.dec });
    }

    await new Promise(r => setTimeout(r, 8000));
  }

  if (signals.length > 0) {
    for (const s of signals) {
      const arrow = s.dir === "LONG" ? "🟢 ▲ LONG" : "🔴 ▼ SHORT";
      const msg = `${arrow} <b>${s.symbol}</b>\n\n` +
        `💰 Entry: <code>${s.entry.toFixed(s.dec)}</code>\n` +
        `✅ TP: <code>${s.tp.toFixed(s.dec)}</code>\n` +
        `🛑 SL: <code>${s.sl.toFixed(s.dec)}</code>\n` +
        `📊 Stärke: <b>${s.strength}%</b>\n` +
        `🕐 ${new Date().toLocaleTimeString("de-DE")}`;
      await sendTelegram(msg);
    }
  }

  res.status(200).json({ signals: signals.length });
}
