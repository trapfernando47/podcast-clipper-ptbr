#!/usr/bin/env node
'use strict';

/**
 * legendar_clipes.js
 *
 * Processa os 10 clipes de maior score do top90_financas.csv,
 * extrai áudio, transcreve com Whisper (PT-BR) e queima legendas
 * estilo Reels nos vídeos verticais.
 */

const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

// ─── Configuração ─────────────────────────────────────────────────────────────

const BASE_DIR       = __dirname;
const INPUT_DIR      = path.join(BASE_DIR, 'clipes-vertical');
const OUTPUT_DIR     = path.join(BASE_DIR, 'clipes-legendados');
const TEMP_DIR       = path.join(BASE_DIR, 'temp_legendas');
const CSV_PATH       = path.join(BASE_DIR, 'top90_financas.csv');
const WHISPER_MODEL  = 'small';        // small ~3-5 min por clipe
const MAX_CLIPES     = 10;

let WHISPER = { cmd: 'whisper', viaModule: false };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] ${msg}`);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function limparTemp() {
  if (fs.existsSync(TEMP_DIR)) {
    fs.rmSync(TEMP_DIR, { recursive: true, force: true });
  }
}

function execPromise(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    log(`  ➤ ${cmd} ${args.join(' ')}`);
    const proc = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        ...opts.env,
      },
      ...opts,
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d; process.stdout.write(d); });
    proc.stderr.on('data', d => { stderr += d; process.stderr.write(d); });
    proc.on('close', code => {
      if (code !== 0) {
        const err = new Error(`Comando falhou com código ${code}: ${stderr.slice(-400)}`);
        err.stderr = stderr;
        err.stdout = stdout;
        return reject(err);
      }
      resolve({ stdout, stderr });
    });
    proc.on('error', reject);
  });
}

// ─── Parse CSV (simples, robusto para este formato) ───────────────────────────

function parseCsvLine(line) {
  const cols = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      cols.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  cols.push(cur.trim());
  return cols;
}

function lerTop90() {
  const raw = fs.readFileSync(CSV_PATH, 'utf-8');
  // Remove BOM
  const text = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
  const lines = text.split(/\r?\n/).filter(Boolean);
  const header = parseCsvLine(lines[0]);
  const idxNumero = header.indexOf('Numero');
  const idxArquivo = header.indexOf('Arquivo');
  const idxScore = header.indexOf('Score');

  if (idxNumero === -1 || idxArquivo === -1 || idxScore === -1) {
    throw new Error('CSV não contém colunas esperadas (Numero, Arquivo, Score)');
  }

  const rows = lines.slice(1).map(line => {
    const cols = parseCsvLine(line);
    return {
      numero: cols[idxNumero],
      arquivo: cols[idxArquivo],
      score: parseFloat(cols[idxScore].replace(',', '.')) || 0,
    };
  });

  // Ordena por score decrescente
  rows.sort((a, b) => b.score - a.score);
  return rows;
}

// ─── Verificar / Instalar Whisper ─────────────────────────────────────────────

function whisperCmd() {
  try {
    execSync('whisper --help', { stdio: 'ignore' });
    return { cmd: 'whisper', viaModule: false };
  } catch {
    try {
      execSync('python -c "import whisper"', { stdio: 'ignore' });
      return { cmd: 'python', viaModule: true };
    } catch {
      return null;
    }
  }
}

function instalarWhisper() {
  log('Whisper não encontrado. Tentando instalar via pip...');
  const pips = ['python -m pip', 'py -m pip', 'pip'];
  let ok = false;
  for (const pip of pips) {
    try {
      execSync(`${pip} install --upgrade pip`, { stdio: 'inherit' });
      execSync(`${pip} install openai-whisper`, { stdio: 'inherit' });
      ok = true;
      break;
    } catch {
      continue;
    }
  }
  if (!ok) {
    throw new Error('Não foi possível instalar o Whisper. Instale manualmente: pip install openai-whisper');
  }
  if (!whisperCmd()) {
    throw new Error('Whisper instalado mas não encontrado no PATH. Reinicie o terminal ou adicione Python Scripts ao PATH.');
  }
  log('Whisper instalado com sucesso.');
}

// ─── Processamento de um clipe ────────────────────────────────────────────────

async function processarClip(clip, idx, total) {
  const nomeBase = path.parse(clip.arquivo).name; // ex: clip-001
  const inputPath = path.join(INPUT_DIR, clip.arquivo);
  const outputPath = path.join(OUTPUT_DIR, clip.arquivo);

  log(`[${idx + 1}/${total}] Processando: ${clip.arquivo} (score: ${clip.score})`);

  if (!fs.existsSync(inputPath)) {
    log(`  ⚠ Arquivo não encontrado: ${inputPath} — pulando.`);
    return { sucesso: false, erro: 'Arquivo não encontrado' };
  }

  ensureDir(TEMP_DIR);
  const audioWav = path.join(TEMP_DIR, `${nomeBase}.wav`);
  const srtPath  = path.join(TEMP_DIR, `${nomeBase}.srt`);

  try {
    // 1) Extrair áudio
    log('  1/4 Extraindo áudio...');
    await execPromise('ffmpeg', [
      '-y', '-i', inputPath,
      '-vn', '-ar', '16000', '-ac', '1',
      audioWav,
    ]);

    // 2) Transcrever com Whisper
    log('  2/4 Transcrevendo com Whisper (modelo small, pt)...');
    const whisperArgs = [
      audioWav,
      '--language', 'pt',
      '--model', WHISPER_MODEL,
      '--output_format', 'srt',
      '--output_dir', TEMP_DIR,
    ];
    if (WHISPER.viaModule) {
      await execPromise(WHISPER.cmd, ['-m', 'whisper', ...whisperArgs]);
    } else {
      await execPromise(WHISPER.cmd, whisperArgs);
    }

    // O Whisper salva como <nome>.wav.srt ou <nome>.srt dependendo da versão
    const possiveisSrt = [
      path.join(TEMP_DIR, `${nomeBase}.srt`),
      path.join(TEMP_DIR, `${nomeBase}.wav.srt`),
    ];
    const srtReal = possiveisSrt.find(p => fs.existsSync(p));
    if (!srtReal) {
      throw new Error('Arquivo SRT não gerado pelo Whisper');
    }

    // 3) Queimar legendas com estilo Reels
    log('  3/4 Queimando legendas no vídeo...');
    // Estilo: fonte grande, branca, contorno preto, caixa alta, centralizada inferior
    // Usamos drawtext para ter mais controle (caixa alta, animação possível)
    // Mas o usuário pediu via subtitles com force_style. Vamos manter o pedido
    // e adicionar um filtro adicional de drawtext se necessário.
    // No entanto, para caixa alta, precisamos preprocessar o SRT.
    const srtUpper = path.join(TEMP_DIR, `${nomeBase}_upper.srt`);
    const srtConteudo = fs.readFileSync(srtReal, 'utf-8');
    // Converte apenas as linhas de texto para uppercase, mantendo timestamps
    const srtUpperConteudo = srtConteudo.split('\n').map(linha => {
      // Se a linha não for número de sequência nem timestamp, é texto
      if (/^\d+$/.test(linha.trim())) return linha;
      if (/\d{2}:\d{2}:\d{2}/.test(linha)) return linha;
      return linha.toUpperCase();
    }).join('\n');
    fs.writeFileSync(srtUpper, srtUpperConteudo, 'utf-8');

    // Fonte: Arial (disponível no Windows). Se não existir, FFmpeg usa fallback.
    // Para vertical 1080x1920, FontSize=48 fica proporcional.
    const style = (
      "FontName=Arial," +
      "FontSize=48," +
      "PrimaryColour=&H00FFFFFF," +   // BGR branco
      "OutlineColour=&H00000000," +   // BGR preto
      "Outline=3," +
      "Bold=1," +
      "Alignment=2," +               // centro inferior
      "MarginV=180," +
      "Shadow=0"
    );

    await execPromise('ffmpeg', [
      '-y', '-i', inputPath,
      '-vf', `subtitles='${srtUpper.replace(/\\/g, '/').replace(/:/g, '\\:')}':force_style='${style}'`,
      '-c:v', 'libx264',
      '-crf', '18',
      '-preset', 'fast',
      '-c:a', 'copy',
      '-movflags', '+faststart',
      outputPath,
    ]);

    log(`  4/4 ✔ Salvo: ${outputPath}`);
    return { sucesso: true };

  } catch (err) {
    log(`  ✘ ERRO em ${clip.arquivo}: ${err.message}`);
    return { sucesso: false, erro: err.message };
  } finally {
    // 4) Limpar temporários deste clipe
    const tempFiles = [audioWav, srtPath, path.join(TEMP_DIR, `${nomeBase}.wav.srt`), path.join(TEMP_DIR, `${nomeBase}_upper.srt`)];
    for (const f of tempFiles) {
      try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {}
    }
  }
}

// ─── Ponto de entrada ─────────────────────────────────────────────────────────

async function main() {
  log('═══════════════════════════════════════════════════');
  log(' INICIANDO LEGENDAGEM AUTOMÁTICA — TOP 10 CLIPES');
  log('═══════════════════════════════════════════════════');

  ensureDir(OUTPUT_DIR);
  limparTemp();

  // Verifica Whisper
  const whisperInfo = whisperCmd();
  if (!whisperInfo) {
    instalarWhisper();
    WHISPER = whisperCmd() || { cmd: 'whisper', viaModule: false };
  } else {
    WHISPER = whisperInfo;
    log(`Whisper detectado (${WHISPER.viaModule ? 'python -m whisper' : 'whisper'}).`);
  }

  // Lê CSV
  log(`Lendo ${CSV_PATH}...`);
  const todos = lerTop90();
  log(`${todos.length} clipes encontrados no CSV.`);

  // Seleciona top 10 que existam fisicamente
  const selecionados = [];
  for (const row of todos) {
    if (selecionados.length >= MAX_CLIPES) break;
    const p = path.join(INPUT_DIR, row.arquivo);
    if (fs.existsSync(p)) {
      selecionados.push(row);
    }
  }

  if (selecionados.length === 0) {
    log('Nenhum clipe encontrado em clipes-vertical/ correspondente ao CSV.');
    process.exit(1);
  }

  log(`Top ${selecionados.length} clipes selecionados:`);
  selecionados.forEach((c, i) => log(`  ${i + 1}. ${c.arquivo} (score: ${c.score})`));

  let ok = 0;
  let falha = 0;

  for (let i = 0; i < selecionados.length; i++) {
    const res = await processarClip(selecionados[i], i, selecionados.length);
    if (res.sucesso) ok++;
    else falha++;
    log('');
  }

  limparTemp();

  log('═══════════════════════════════════════════════════');
  log(' RESUMO');
  log(`  Processados com sucesso: ${ok}`);
  log(`  Falhas:                  ${falha}`);
  log(`  Pasta de saída:          ${OUTPUT_DIR}`);
  log('═══════════════════════════════════════════════════');
}

main().catch(err => {
  console.error('Erro fatal:', err);
  process.exit(1);
});
