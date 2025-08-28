// API Inter Pix Bridge (Node.js + Express + mTLS)
const express = require("express");
const axios = require("axios");
const https = require("https");

const {
  PORT = 8080,
  API_KEY,
  INTER_BASE = "https://cdpj.partners.bancointer.com.br",
  INTER_CLIENT_ID,
  INTER_CLIENT_SECRET,
  INTER_CERT_PFX_BASE64,
  INTER_CERT_PASSPHRASE,
  INTER_PIX_CHAVE,
  INTER_PIX_QR_EXPIRA_SEG = "1800"
} = process.env;

const httpsAgent = new https.Agent({
  pfx: Buffer.from(INTER_CERT_PFX_BASE64 || "", "base64"),
  passphrase: INTER_CERT_PASSPHRASE || "",
  rejectUnauthorized: true
});

let cachedToken = null;
let cachedExp = 0;

async function getToken() {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && now < cachedExp - 30) return cachedToken;

  const url = `${INTER_BASE}/oauth/v2/token`;
  const params = new URLSearchParams();
  params.append("client_id", INTER_CLIENT_ID);
  params.append("client_secret", INTER_CLIENT_SECRET);
  params.append("grant_type", "client_credentials");
  params.append("scope", "pix.read pix.write");

  const resp = await axios.post(url, params, {
    httpsAgent,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 15000
  });

  cachedToken = resp.data?.access_token;
  cachedExp   = Math.floor(Date.now()/1000) + (resp.data?.expires_in || 3600);
  return cachedToken;
}

function fix2(v){ return Number(v||0).toFixed(2); }
function genTxid(prefix="YS"){
  const t = Math.floor(Date.now()/1000).toString(36);
  const r = Math.random().toString(36).slice(2,10);
  return (prefix + t + r).slice(0, 35);
}

const app = express();
app.use(express.json());

// Autenticação por API Key
app.use((req,res,next)=>{
  const k = req.header("x-api-key");
  if (!API_KEY || k === API_KEY) return next();
  return res.status(401).json({ success:false, error:"unauthorized" });
});

app.get("/health", (_,res)=> res.json({ ok:true, ts:Date.now() }));

// Endpoint para criar cobrança Pix
app.post("/pix/cob", async (req,res)=>{
  try{
    const { cpf, valor, descricao, txid:txidIn, pagador_nome } = req.body || {};
    if(!cpf || !valor) return res.status(400).json({ success:false, error:"Campos obrigatórios: cpf, valor" });

    if(!INTER_PIX_CHAVE) return res.status(500).json({ success:false, error:"INTER_PIX_CHAVE não configurada" });

    const txid   = txidIn || genTxid("YS");
    const token  = await getToken();
    const body   = {
      calendario: { expiracao: Number(INTER_PIX_QR_EXPIRA_SEG) },
      devedor: { cpf, nome: pagador_nome || "Cliente" },
      valor: { original: fix2(valor) },
      chave: INTER_PIX_CHAVE,
      solicitacaoPagador: descricao || "Pagamento de coparticipação"
    };

    const urlCob = `${INTER_BASE}/pix/v2/cob/${txid}`;
    const rCob = await axios.put(urlCob, body, {
      httpsAgent,
      headers: { "Authorization":`Bearer ${token}`, "Content-Type":"application/json" },
      timeout: 20000
    });

    const locId = rCob.data?.loc?.id;
    let qrc = null;
    if (locId){
      const urlQr = `${INTER_BASE}/pix/v2/loc/${locId}/qrcode`;
      const rQr = await axios.get(urlQr, {
        httpsAgent, headers: { "Authorization":`Bearer ${token}` }, timeout: 15000
      });
      qrc = rQr.data;
    }

    return res.json({
      success: true,
      txid,
      valor: fix2(valor),
      status: rCob.data?.status || "CRIADA",
      pix_location: rCob.data?.loc?.location || null,
      copia_cola: qrc?.qrcode || null,
      qrcode_base64: qrc?.imagemQrcode || null,
      expiracao_segundos: Number(INTER_PIX_QR_EXPIRA_SEG),
      raw: { cob: rCob.data }
    });
  }catch(err){
    const status = err?.response?.status || 500;
    return res.status(status).json({
      success:false,
      error:"Falha ao criar cobrança Pix",
      detail: String(err?.response?.data || err?.message || err)
    });
  }
});

app.listen(PORT, ()=> console.log(`Inter Pix Bridge on :${PORT}`));
