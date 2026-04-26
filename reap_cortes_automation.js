'use strict';

/**
 * reap_cortes_automation.js
 *
 * Automação de 270 cortes de podcast via API do Reap.
 * Base URL: https://public.reap.video/api/v1
 * Auth: Authorization: Bearer <token>
 *
 * USO:
 *   $env:REAP_API_KEY="chave"; node reap_cortes_automation.js --apenas-1-financa
 *   $env:REAP_API_KEY="chave"; node reap_cortes_automation.js --dry-run
 *   $env:REAP_API_KEY="chave"; node reap_cortes_automation.js --nicho financas
 *   $env:REAP_API_KEY="chave"; node reap_cortes_automation.js --list-presets
 *   $env:REAP_API_KEY="chave"; node reap_cortes_automation.js
 */

const axios = require('axios');
const fs    = require('fs');
const path  = require('path');

// ─── Configuração ─────────────────────────────────────────────────────────────

const REAP_API_KEY = process.env.REAP_API_KEY;
const BASE_URL     = 'https://public.reap.video/api/v1';

const CAPTION_PRESETS = {
  financas: process.env.REAP_PRESET_FINANCAS || 'system_beasty',
  saude:    process.env.REAP_PRESET_SAUDE    || 'system_clean',
  carreira: process.env.REAP_PRESET_CARREIRA || 'system_bold',
};

const NICHE_CONFIG = {
  financas: { enableEmojis: false, enableHighlights: true },
  saude:    { enableEmojis: false, enableHighlights: true },
  carreira: { enableEmojis: true,  enableHighlights: true },
};

const NICHO_PASTA = {
  financas: 'cortes-financas',
  saude:    'cortes-saude',
  carreira: 'cortes-carreira',
};

// ─── Rate limits ──────────────────────────────────────────────────────────────

const MAX_REQ_PER_MIN  = 10;
const MAX_CONCURRENT   = 5;
const POLL_INTERVAL_MS = 30_000;   // produção: 30s entre polls
const POLL_MAX_TRIES   = 120;      // produção: 60 min máximo por projeto

// Modo --apenas-1-financa usa intervalos reduzidos para iteração rápida
const TEST_POLL_INTERVAL_MS = 20_000;  // 20s
const TEST_POLL_MAX_TRIES   = 30;      // 10 min máximo

// ─── Clientes HTTP ────────────────────────────────────────────────────────────

const api = axios.create({
  baseURL: BASE_URL,
  headers: {
    'Authorization': `Bearer ${REAP_API_KEY}`,
    'Content-Type':  'application/json',
  },
  timeout: 30_000,
});

// ─── Rate Limiter ─────────────────────────────────────────────────────────────

class RateLimiter {
  constructor(maxPerMinute, maxConcurrent) {
    this.maxPerMinute  = maxPerMinute;
    this.maxConcurrent = maxConcurrent;
    this.queue         = [];
    this.running       = 0;
    this.reqThisMin    = 0;
    this.minStart      = Date.now();
  }

  execute(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this._drain();
    });
  }

  async _drain() {
    if (this.running >= this.maxConcurrent || !this.queue.length) return;

    const now = Date.now();
    if (now - this.minStart >= 60_000) {
      this.reqThisMin = 0;
      this.minStart   = now;
    }

    if (this.reqThisMin >= this.maxPerMinute) {
      const wait = 60_000 - (now - this.minStart) + 500;
      setTimeout(() => this._drain(), wait);
      return;
    }

    const { fn, resolve, reject } = this.queue.shift();
    this.running++;
    this.reqThisMin++;

    try   { resolve(await fn()); }
    catch (e) { reject(e); }
    finally {
      this.running--;
      this._drain();
    }
  }
}

const limiter = new RateLimiter(MAX_REQ_PER_MIN, MAX_CONCURRENT);

// ─── Helpers ──────────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

function log(msg) {
  process.stdout.write(`[${new Date().toISOString()}] ${msg}\n`);
}

/**
 * Retorna true apenas se a URL for uma string válida que começa com "http"
 * e contém "youtube.com" ou "youtu.be".
 * Retorna false para ausente, vazio, nulo, ou a string-placeholder original.
 */
function isUrlValida(url) {
  if (!url || typeof url !== 'string') return false;
  const s = url.trim();
  if (!s || s === 'SUBSTITUIR_URL_YOUTUBE') return false;
  return s.startsWith('http') && (s.includes('youtube.com') || s.includes('youtu.be'));
}

/**
 * Carrega cortes dos arquivos JSON de plano.
 * filtroNicho: 'financas' | 'saude' | 'carreira' | null
 * filtroIds:   array de IDs a incluir, ou null para todos
 */
function loadCortes(filtroNicho = null, filtroIds = null) {
  const nichos = ['financas', 'saude', 'carreira'];
  let todos = [];

  for (const nicho of nichos) {
    if (filtroNicho && nicho !== filtroNicho) continue;
    const filePath = path.join(__dirname, `cortes_plano_${nicho}.json`);
    if (!fs.existsSync(filePath)) {
      log(`AVISO: arquivo não encontrado – ${filePath}`);
      continue;
    }
    const cortes = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    todos = todos.concat(cortes);
  }

  if (filtroIds && filtroIds.length) {
    const ids = new Set(filtroIds);
    todos = todos.filter(c => ids.has(c.id));
  }

  return todos;
}

/**
 * Salva o estado atual usando um Map<corte_id, resultado>.
 * Nunca substitui um resultado 'ok' existente por outro status.
 */
function saveProgress(resultMap, outputPath) {
  const resultados = [...resultMap.values()];
  const summary = {
    gerado_em:  new Date().toISOString(),
    total:      resultados.length,
    ok:         resultados.filter(r => r.status === 'ok').length,
    erros:      resultados.filter(r => r.status === 'error').length,
    ignorados:  resultados.filter(r => r.status === 'skipped').length,
    resultados,
  };
  fs.writeFileSync(outputPath, JSON.stringify(summary, null, 2));
}

// ─── Chamadas à API ───────────────────────────────────────────────────────────

async function listPresets() {
  const res = await api.get('/automation/get-all-presets', { params: { pageSize: 50 } });
  return res.data;
}

async function createClipProject(corte) {
  const nicheConf = NICHE_CONFIG[corte.nicho] || {};

  const payload = {
    sourceUrl:         corte.episodio_url,
    exportOrientation: 'portrait',
    exportResolution:  1080,
    captionsPreset:    CAPTION_PRESETS[corte.nicho] || 'system_beasty',
    language:          'pt',
    clipDurations:     [[30, 60]],
    topics:            [corte.tema, corte.titulo_corte, corte.gancho_texto.substring(0, 120)],
    enableHighlights:  nicheConf.enableHighlights ?? true,
    enableEmojis:      nicheConf.enableEmojis      ?? false,
  };

  const res = await api.post('/automation/create-clips', payload);
  return res.data;
}

async function pollProjectStatus(projectId, opts = {}) {
  const maxTries    = opts.maxTries    ?? POLL_MAX_TRIES;
  const intervalMs  = opts.intervalMs  ?? POLL_INTERVAL_MS;
  const verbose     = opts.verbose     ?? false;

  // Estados documentados pela Reap:
  //   queued → prepped → draft → processing → finalizing → completed
  //   invalid | expired | failed | error  (terminais de erro)
  const TERMINAL_OK  = new Set(['completed']);
  const TERMINAL_ERR = new Set(['failed', 'error', 'invalid', 'expired']);

  for (let i = 0; i < maxTries; i++) {
    await sleep(intervalMs);

    let res;
    try {
      res = await limiter.execute(() =>
        api.get('/automation/get-project-status', { params: { projectId } })
      );
    } catch (httpErr) {
      log(`  [poll ${i + 1}/${maxTries}] ERRO HTTP: ${httpErr.message}`);
      if (httpErr.response) {
        log(`  Response ${httpErr.response.status}: ${JSON.stringify(httpErr.response.data)}`);
      }
      throw httpErr;
    }

    const status = res.data?.status;
    log(`  [poll ${i + 1}/${maxTries}] status: ${status ?? '(campo ausente)'}`);

    if (verbose || !status || (!TERMINAL_OK.has(status) && !TERMINAL_ERR.has(status) &&
        !['queued','prepped','draft','processing','finalizing'].includes(status))) {
      log(`  Response completo: ${JSON.stringify(res.data)}`);
    }

    if (TERMINAL_OK.has(status))  return status;
    if (TERMINAL_ERR.has(status)) {
      log(`  Response completo: ${JSON.stringify(res.data)}`);
      throw new Error(`Projeto ${projectId} terminou com status de erro: "${status}"`);
    }
    // queued / prepped / draft / processing / finalizing → continua esperando
  }

  throw new Error(`Projeto ${projectId} excedeu ${maxTries} tentativas (${(maxTries * intervalMs / 60000).toFixed(0)} min)`);
}

async function getProjectClips(projectId) {
  const res = await api.get('/automation/get-project-clips', {
    params: { projectId, page: 1, pageSize: 5 },
  });
  log(`  get-project-clips response: ${JSON.stringify(res.data).substring(0, 400)}`);
  return res.data.clips || res.data.data || (Array.isArray(res.data) ? res.data : []);
}

/**
 * Baixa um clipe MP4 de uma URL pública e salva em destPath.
 */
async function downloadClip(downloadUrl, destPath) {
  const res = await axios({
    url:          downloadUrl,
    method:       'GET',
    responseType: 'stream',
    timeout:      300_000,
  });

  return new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(destPath);
    res.data.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

// ─── Processamento de um corte ────────────────────────────────────────────────

async function processCorte(corte, index, total, opts = {}) {
  const {
    dryRun      = false,
    pollInterval = POLL_INTERVAL_MS,
    pollMaxTries = POLL_MAX_TRIES,
    pollVerbose  = false,
  } = opts;
  const prefix = `[${String(index + 1).padStart(3, '0')}/${total}]`;
  log(`${prefix} ${corte.nicho.toUpperCase()} | ${corte.podcast} | "${corte.titulo_corte}"`);

  // Validação da URL
  if (!isUrlValida(corte.episodio_url)) {
    const motivo = !corte.episodio_url ? 'episodio_url ausente' :
                   corte.episodio_url === 'SUBSTITUIR_URL_YOUTUBE' ? 'URL placeholder não substituída' :
                   `URL inválida: "${corte.episodio_url}"`;
    log(`  IGNORADO – ${motivo} (id: ${corte.id})`);
    return {
      status:          'skipped',
      corte_id:        corte.id,
      motivo,
      corte_planejado: corte,
    };
  }

  log(`  URL: ${corte.episodio_url}`);

  if (dryRun) {
    log(`  [DRY-RUN] URL válida – criação de projeto simulada`);
    return {
      status:          'dry-run',
      corte_id:        corte.id,
      corte_planejado: corte,
    };
  }

  try {
    // 1. Cria projeto
    const project   = await limiter.execute(() => createClipProject(corte));
    log(`  Resposta create-clips: ${JSON.stringify(project).substring(0, 500)}`);
    const projectId = project.id || project.projectId || project.project_id;
    if (!projectId) throw new Error(`Resposta da API sem campo id/projectId: ${JSON.stringify(project)}`);
    log(`  Projeto criado: ${projectId} | status inicial: ${project.status}`);

    // 2. Aguarda conclusão
    await pollProjectStatus(projectId, {
      maxTries:   pollMaxTries,
      intervalMs: pollInterval,
      verbose:    pollVerbose,
    });

    // 3. Busca clipes gerados
    const clips = await limiter.execute(() => getProjectClips(projectId));
    const clip  = clips[0];
    if (!clip) throw new Error(`Projeto ${projectId} completou mas retornou 0 clipes`);

    // Campo correto per Reap docs: clipUrl (downloadUrl é legado/inexistente)
    const downloadUrl = clip.clipUrl || clip.downloadUrl || clip.url || clip.download_url || null;
    log(`  clip.clipUrl=${clip.clipUrl} | clip.id=${clip.id || clip.clipId}`);

    // 4. Baixa o MP4
    let caminhoArquivo = null;
    if (downloadUrl) {
      const pasta     = NICHO_PASTA[corte.nicho] || `cortes-${corte.nicho}`;
      const pastaPath = path.join(__dirname, pasta);
      if (!fs.existsSync(pastaPath)) fs.mkdirSync(pastaPath, { recursive: true });
      const destPath = path.join(pastaPath, `${corte.id}.mp4`);
      log(`  Baixando clipe → ${pasta}/${corte.id}.mp4 ...`);
      await downloadClip(downloadUrl, destPath);
      caminhoArquivo = `${pasta}/${corte.id}.mp4`;
      log(`  Download OK → ${caminhoArquivo}`);
    } else {
      log(`  AVISO: clipe sem download_url – arquivo não salvo localmente`);
    }

    return {
      status:          'ok',
      corte_id:        corte.id,
      projeto_id:      projectId,
      caminho_arquivo: caminhoArquivo,
      corte_planejado: {
        nicho:            corte.nicho,
        podcast:          corte.podcast,
        episodio_url:     corte.episodio_url,
        tema:             corte.tema,
        titulo_corte:     corte.titulo_corte,
        gancho_texto:     corte.gancho_texto,
        duracao_segundos: corte.duracao_segundos,
        plataformas:      corte.plataforma_destino,
      },
      reap: {
        project_id:   projectId,
        clip_id:      clip.id || clip.clipId || null,
        titulo_reap:  clip.title  || null,
        download_url: downloadUrl,
        duracao_s:    clip.duration   || null,
        tempo_inicio: clip.startTime  || clip.start_time || null,
        tempo_fim:    clip.endTime    || clip.end_time   || null,
        todos_clips:  clips.map(c => ({
          clip_id:      c.id || c.clipId,
          titulo:       c.title,
          clip_url:     c.clipUrl || c.downloadUrl || c.url || c.download_url,
          duracao_s:    c.duration,
          inicio:       c.startTime || c.start_time,
          fim:          c.endTime   || c.end_time,
          virality:     c.viralityScore,
        })),
      },
      processado_em: new Date().toISOString(),
    };

  } catch (err) {
    log(`  ERRO – ${err.message}`);
    return {
      status:          'error',
      corte_id:        corte.id,
      corte_planejado: corte,
      erro:            err.message,
      processado_em:   new Date().toISOString(),
    };
  }
}

// ─── Ponto de entrada ─────────────────────────────────────────────────────────

async function main() {
  const args           = process.argv.slice(2);
  const dryRun         = args.includes('--dry-run');
  const apenasUm       = args.includes('--apenas-1-financa');
  const listPresetsMode = args.includes('--list-presets');
  const nichoIdx       = args.indexOf('--nicho');
  const filtroNicho    = nichoIdx !== -1 ? args[nichoIdx + 1] : null;

  if (!REAP_API_KEY) {
    console.error('REAP_API_KEY não definida.');
    console.error('PowerShell: $env:REAP_API_KEY="sua_chave"; node reap_cortes_automation.js ...');
    process.exit(1);
  }

  if (listPresetsMode) {
    log('Buscando presets da conta...');
    const data = await listPresets();
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  const outputPath = path.join(__dirname, 'cortes_reap_resultado.json');

  // Carrega resultados anteriores em um Map para deduplicação por corte_id.
  // Uma entrada com status 'ok' nunca é sobrescrita.
  const resultMap = new Map();
  if (fs.existsSync(outputPath)) {
    try {
      const prev = JSON.parse(fs.readFileSync(outputPath, 'utf-8'));
      for (const r of (prev.resultados || [])) {
        if (r.corte_id) resultMap.set(r.corte_id, r);
      }
    } catch {
      log('AVISO: cortes_reap_resultado.json corrompido – iniciando do zero.');
    }
    const jaOk = [...resultMap.values()].filter(r => r.status === 'ok').length;
    if (jaOk > 0) log(`Retomando: ${jaOk} cortes já com status "ok".`);
  }

  // ── Modo teste: apenas fin-01 ─────────────────────────────────────────────
  if (apenasUm) {
    log('═══════════════════════════════════════════════════');
    log('MODO TESTE: processando apenas fin-01');
    log('═══════════════════════════════════════════════════\n');

    const [corte] = loadCortes('financas', ['fin-01']);
    if (!corte) {
      log('ERRO: corte fin-01 não encontrado em cortes_plano_financas.json');
      process.exit(1);
    }

    const existente = resultMap.get('fin-01');
    if (existente?.status === 'ok') {
      log(`fin-01 já processado com sucesso. Arquivo: ${existente.caminho_arquivo}`);
      return;
    }

    const resultado = await processCorte(corte, 0, 1, {
      dryRun,
      pollInterval: TEST_POLL_INTERVAL_MS,
      pollMaxTries: TEST_POLL_MAX_TRIES,
      pollVerbose:  true,   // loga response completo em cada poll no modo teste
    });
    resultMap.set('fin-01', resultado);
    saveProgress(resultMap, outputPath);

    log('\n═══════════════════════════════════════════════════');
    log('RESULTADO DO TESTE:');
    log(`  status:          ${resultado.status}`);
    log(`  corte_id:        ${resultado.corte_id}`);
    log(`  projeto_id:      ${resultado.projeto_id || '–'}`);
    log(`  caminho_arquivo: ${resultado.caminho_arquivo || '–'}`);
    if (resultado.erro) log(`  erro:            ${resultado.erro}`);
    log('═══════════════════════════════════════════════════');
    return;
  }

  // ── Modo completo ─────────────────────────────────────────────────────────

  // Filtra cortes que ainda não têm status 'ok'
  const todosCortes = loadCortes(filtroNicho)
    .filter(c => resultMap.get(c.id)?.status !== 'ok');
  const total = todosCortes.length;

  log(`═══════════════════════════════════════════════════`);
  log(`Cortes a processar: ${total}${filtroNicho ? ` (nicho: ${filtroNicho})` : ''}`);
  if (dryRun) log('MODO DRY-RUN – nenhuma chamada real será feita');
  log(`═══════════════════════════════════════════════════\n`);

  for (let i = 0; i < total; i += MAX_CONCURRENT) {
    const batch   = todosCortes.slice(i, i + MAX_CONCURRENT);
    const results = await Promise.all(
      batch.map((corte, j) => processCorte(corte, i + j, total, { dryRun }))
    );

    for (const r of results) {
      if (!r.corte_id) continue;
      // Nunca sobrescreve um 'ok' com algo pior
      if (resultMap.get(r.corte_id)?.status !== 'ok') {
        resultMap.set(r.corte_id, r);
      }
    }

    saveProgress(resultMap, outputPath);

    const vals  = [...resultMap.values()];
    const ok    = vals.filter(r => r.status === 'ok').length;
    const erros = vals.filter(r => r.status === 'error').length;
    const skip  = vals.filter(r => r.status === 'skipped').length;
    log(`\n── Progresso: ${ok} ok | ${erros} erros | ${skip} ignorados ──\n`);
  }

  const vals  = [...resultMap.values()];
  log(`\n${'═'.repeat(51)}`);
  log('PROCESSAMENTO CONCLUÍDO');
  log(`Total:    ${vals.length}`);
  log(`OK:       ${vals.filter(r => r.status === 'ok').length}`);
  log(`Erros:    ${vals.filter(r => r.status === 'error').length}`);
  log(`Ignorados:${vals.filter(r => r.status === 'skipped').length}`);
  log(`Resultado: ${outputPath}`);
  log(`${'═'.repeat(51)}`);
}

main().catch(err => {
  console.error('Erro fatal:', err.message);
  process.exit(1);
});
