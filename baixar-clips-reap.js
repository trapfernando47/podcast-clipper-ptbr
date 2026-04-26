const fs = require("fs");
const path = require("path");

const API_BASE = process.env.REAP_API_BASE || "https://public.reap.video/api/v1/automation";
const API_KEY = process.env.REAP_API_KEY;

if (!API_KEY) {
  console.error("Defina REAP_API_KEY antes de rodar.");
  process.exit(1);
}

const headers = {
  "Authorization": `Bearer ${API_KEY}`,
  "Content-Type": "application/json"
};

const pastaFinancas = path.join(__dirname, "cortes-financas");
const resultadoPath = path.join(__dirname, "cortes_reap_resultado.json");

const CONCORRENCIA = 6;
const API_TIMEOUT_MS = 20_000;
const VIDEO_TIMEOUT_MS = 300_000;
const MAX_RETRIES = 4;
const RETRY_DELAYS = [1_000, 2_000, 4_000, 8_000];
const RETRY_ERROR_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "ECONNRESET"]);
const RETRY_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);

function garantirPasta(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function lerJsonSeguro(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function salvarJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

function ehErroRetryable(err, statusCode) {
  if (statusCode && RETRY_STATUS_CODES.has(statusCode)) return true;
  const code = err && (err.code || err.cause?.code) || "";
  if (RETRY_ERROR_CODES.has(code)) return true;
  if (err && (err.name === "AbortError" || err.message?.includes("timeout"))) return true;
  return false;
}

/**
 * Função genérica de fetch com retry, parametrizando o timeout.
 */
async function fetchComRetryGenerico(url, opts = {}, timeoutMs) {
  let lastError;
  for (let tentativa = 0; tentativa < MAX_RETRIES; tentativa++) {
    try {
      const res = await fetch(url, {
        ...opts,
        signal: AbortSignal.timeout(timeoutMs)
      });

      if (!res.ok) {
        if (ehErroRetryable(null, res.status) && tentativa < MAX_RETRIES - 1) {
          await sleep(RETRY_DELAYS[tentativa]);
          continue;
        }
        const txt = await res.text();
        throw new Error(`HTTP ${res.status} – ${txt.slice(0, 200)}`);
      }
      return res;
    } catch (err) {
      lastError = err;
      if (ehErroRetryable(err, null) && tentativa < MAX_RETRIES - 1) {
        await sleep(RETRY_DELAYS[tentativa]);
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

/**
 * APIs leves da Reap (listar projetos, etc.) – timeout de 20s.
 */
async function fetchApiComRetry(url, opts = {}) {
  return fetchComRetryGenerico(url, { ...opts, headers: { ...headers, ...(opts.headers || {}) } }, API_TIMEOUT_MS);
}

/**
 * Download de vídeo MP4 – timeout de 300s.
 */
async function fetchVideoComRetry(url, opts = {}) {
  return fetchComRetryGenerico(url, opts, VIDEO_TIMEOUT_MS);
}

async function getJson(url) {
  const res = await fetchApiComRetry(url, { method: "GET" });
  return res.json();
}

async function baixarArquivo(url, destino) {
  const res = await fetchVideoComRetry(url, { method: "GET" });
  const arrayBuffer = await res.arrayBuffer();
  fs.writeFileSync(destino, Buffer.from(arrayBuffer));
}

/**
 * Lista todos os projetos completed com videoFile.
 */
async function listarTodosProjetos() {
  const pagina1 = await getJson(`${API_BASE}/get-all-projects?page=1&pageSize=100`);
  const projetos = [...(pagina1.projects || [])];
  const totalPages = pagina1.totalPages || 1;

  for (let page = 2; page <= totalPages; page++) {
    const pagina = await getJson(`${API_BASE}/get-all-projects?page=${page}&pageSize=100`);
    projetos.push(...(pagina.projects || []));
  }

  return projetos;
}

/**
 * Descobre o próximo número de fin-XX baseado no JSON existente.
 * - Lê todos os corte_id existentes.
 * - Extrai os números de fin-XX.
 * - Pega o maior e soma 1; se não houver, começa de 1.
 */
function calcularProximoNumeroCorte(banco) {
  const numeros = [];

  for (const r of banco.resultados || []) {
    if (!r.corte_id) continue;
    const m = r.corte_id.match(/^fin-(\d+)$/i);
    if (m) {
      const n = parseInt(m[1], 10);
      if (!Number.isNaN(n)) numeros.push(n);
    }
  }

  if (!numeros.length) return 1;
  return Math.max(...numeros) + 1;
}

/**
 * Gera um novo corte_id fin-XX sequencial.
 */
function gerarCorteIdSequencial(proximoNumeroRef) {
  const numero = proximoNumeroRef.valor;
  proximoNumeroRef.valor += 1;
  const numStr = String(numero).padStart(2, "0");
  return `fin-${numStr}`;
}

function carregarBanco() {
  const banco = lerJsonSeguro(resultadoPath, { resultados: [] });
  if (!Array.isArray(banco.resultados)) banco.resultados = [];

  const porProjetoId = new Map();
  const porCorteId = new Map();

  for (const r of banco.resultados) {
    if (r.projeto_id && r.status === "ok") {
      porProjetoId.set(r.projeto_id, r);
    }
    if (r.corte_id && r.status === "ok") {
      porCorteId.set(r.corte_id, r);
    }
  }

  return { banco, porProjetoId, porCorteId };
}

function mesclarResultado(banco, resultado) {
  const idx = banco.resultados.findIndex(r =>
    (r.projeto_id && r.projeto_id === resultado.projeto_id) ||
    (r.corte_id && r.corte_id === resultado.corte_id)
  );

  if (idx >= 0) {
    const existente = banco.resultados[idx];
    if (existente.status === "ok") return false;
    banco.resultados[idx] = resultado;
  } else {
    banco.resultados.push(resultado);
  }
  return true;
}

/**
 * Processa um projeto:
 * - Se já tiver entrada ok + arquivo existente, dá SKIP.
 * - Senão gera novo corte_id sequencial (fin-XX) e usa como nome de arquivo.
 */
async function processarProjeto(projeto, porProjetoId, porCorteId, proximoNumeroRef) {
  // 1) Se já tem OK por projeto_id e arquivo existe, SKIP
  const jaOkPorProjeto = porProjetoId.get(projeto.id);
  if (jaOkPorProjeto) {
    const corteIdExistente = jaOkPorProjeto.corte_id || projeto.id;
    const arquivoExiste = jaOkPorProjeto.caminho_arquivo &&
      fs.existsSync(path.join(__dirname, jaOkPorProjeto.caminho_arquivo));
    if (arquivoExiste) {
      console.log(`SKIP ${corteIdExistente} já concluído`);
      return { tipo: "skip", projeto_id: projeto.id };
    }
  }

  // 2) Gera novo corte_id sequencial
  const corteId = gerarCorteIdSequencial(proximoNumeroRef);
  const nomeArquivo = `${corteId}.mp4`;

  // 3) Se já existe entrada ok para esse corte_id e arquivo existe, SKIP
  if (porCorteId.has(corteId)) {
    const jaOk = porCorteId.get(corteId);
    const arquivoExiste = jaOk.caminho_arquivo &&
      fs.existsSync(path.join(__dirname, jaOk.caminho_arquivo));
    if (arquivoExiste) {
      console.log(`SKIP ${corteId} já concluído`);
      return { tipo: "skip", projeto_id: projeto.id };
    }
  }

  const destinoAbs = path.join(pastaFinancas, nomeArquivo);
  const destinoRel = path.posix.join("cortes-financas", nomeArquivo);

  try {
    console.log(`OK   ${corteId} baixando ${projeto.id} → ${nomeArquivo}`);
    await baixarArquivo(projeto.urls.videoFile, destinoAbs);

    const resultado = {
      status: "ok",
      corte_id: corteId,
      projeto_id: projeto.id,
      caminho_arquivo: destinoRel,
      processado_em: new Date().toISOString()
    };

    return { tipo: "ok", resultado };
  } catch (err) {
    const mensagem = err.message || String(err);
    console.error(`ERRO ${corteId} ${projeto.id} – ${mensagem}`);

    const resultado = {
      status: "erro",
      corte_id: corteId,
      projeto_id: projeto.id,
      caminho_arquivo: "",
      mensagem_erro: mensagem,
      processado_em: new Date().toISOString()
    };

    return { tipo: "erro", resultado };
  }
}

async function main() {
  garantirPasta(pastaFinancas);

  const { banco, porProjetoId, porCorteId } = carregarBanco();

  // Calcula a partir do JSON qual será o próximo número de fin-XX
  const proximoNumeroRef = { valor: calcularProximoNumeroCorte(banco) };

  console.log("Listando projetos na Reap...");
  const projetos = await listarTodosProjetos();
  const completed = projetos.filter(p => p.status === "completed" && p.urls && p.urls.videoFile);

  console.log(`Projetos encontrados: ${projetos.length}`);
  console.log(`Projetos completed com videoFile: ${completed.length}`);
  console.log(`Já ok no JSON: ${porProjetoId.size} por projeto_id, ${porCorteId.size} por corte_id`);
  console.log("");

  let baixados = 0;
  let pulados = 0;
  let erros = 0;

  for (let i = 0; i < completed.length; i += CONCORRENCIA) {
    const lote = completed.slice(i, i + CONCORRENCIA);
    const settled = await Promise.allSettled(
      lote.map(p => processarProjeto(p, porProjetoId, porCorteId, proximoNumeroRef))
    );

    for (const s of settled) {
      if (s.status === "rejected") {
        console.error(`ERRO inesperado no lote: ${s.reason?.message || s.reason}`);
        erros++;
        continue;
      }

      const val = s.value;
      if (val.tipo === "skip") {
        pulados++;
      } else if (val.tipo === "ok") {
        mesclarResultado(banco, val.resultado);
        porProjetoId.set(val.resultado.projeto_id, val.resultado);
        porCorteId.set(val.resultado.corte_id, val.resultado);
        baixados++;
      } else if (val.tipo === "erro") {
        mesclarResultado(banco, val.resultado);
        erros++;
      }
    }

    salvarJson(resultadoPath, banco);
    console.log(`── Lote ${Math.floor(i / CONCORRENCIA) + 1}/${Math.ceil(completed.length / CONCORRENCIA)} | ok=${baixados} skip=${pulados} erro=${erros} ──`);
  }

  console.log("");
  console.log("Concluído.");
  console.log(`Baixados: ${baixados}`);
  console.log(`Pulados:  ${pulados}`);
  console.log(`Erros:    ${erros}`);
}

main().catch(err => {
  console.error("Erro fatal:", err);
  process.exit(1);
});