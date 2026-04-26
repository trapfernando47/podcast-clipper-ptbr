'use strict';

/**
 * minar_episodios.js
 *
 * Minera episódios recentes (últimos 30 dias) dos canais do YouTube
 * usando yt-dlp e atualiza os cortes_plano_*.json com as URLs reais.
 *
 * Se um canal não tiver episódios recentes suficientes, usa o mais recente disponível.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const DIAS_LIMITE = 30;
const MIN_DURACAO_S = 1200; // 20 min mínimo para ser considerado episódio longo
const PLAYLIST_END = 10;    // verifica os 10 vídeos mais recentes

// ─── Podcasts a minerar ───────────────────────────────────────────────────────
const PODCASTS = [
  // Finanças
  { id: 'primo-rico',      canal: 'https://www.youtube.com/@pricorico',         nicho: 'financas' },
  { id: 'me-poupe',        canal: 'https://www.youtube.com/@MePoupe',            nicho: 'financas' },
  { id: 'market-makers',   canal: 'https://www.youtube.com/@marketmakers',       nicho: 'financas' },
  { id: 'stock-pickers',   canal: 'https://www.youtube.com/@stockpickers',       nicho: 'financas' },
  { id: 'jornada-dinheiro',canal: 'https://www.youtube.com/@jornadododinheiro',  nicho: 'financas' },
  // Saúde
  { id: 'flow-podcast',        canal: 'https://www.youtube.com/@flowpodcast',        nicho: 'saude' },
  { id: 'inteligencia-ltda',   canal: 'https://www.youtube.com/@inteligencialtda',   nicho: 'saude' },
  { id: 'cana-podcast',        canal: 'https://www.youtube.com/@canapodcast',         nicho: 'saude' },
  { id: 'podpah-saude',        canal: 'https://www.youtube.com/@podpah',              nicho: 'saude' },
  { id: 'longevidade-em-foco', canal: 'https://www.youtube.com/@longevidadeemfoco',  nicho: 'saude' },
  // Carreira
  { id: 'startse-podcast',  canal: 'https://www.youtube.com/@startse',          nicho: 'carreira' },
  { id: 'cafe-com-adm',     canal: 'https://www.youtube.com/@cafecomadm',       nicho: 'carreira' },
  { id: 'nerdcast',         canal: 'https://www.youtube.com/@jovemnerd',        nicho: 'carreira' },
  { id: 'tribo-de-experts', canal: 'https://www.youtube.com/@joeljota',         nicho: 'carreira' },
  { id: 'digital-talks',    canal: 'https://www.youtube.com/@digitaltalks',     nicho: 'carreira' },
];

function log(msg) {
  process.stdout.write(`[${new Date().toISOString()}] ${msg}\n`);
}

function dataLimite() {
  const d = new Date();
  d.setDate(d.getDate() - DIAS_LIMITE);
  return d.getFullYear() * 10000 +
    (d.getMonth() + 1) * 100 +
    d.getDate(); // YYYYMMDD como número
}

/**
 * Usa yt-dlp para listar os vídeos mais recentes de um canal.
 * Retorna array de { url, titulo, duracao_s, upload_date }
 */
function listarVideos(canalUrl) {
  try {
    // yt-dlp --flat-playlist imprime metadados sem baixar
    const cmd = [
      'yt-dlp',
      '--flat-playlist',
      `--playlist-end ${PLAYLIST_END}`,
      '--print "%(upload_date)s\t%(duration)s\t%(url)s\t%(title)s"',
      '--no-warnings',
      '--quiet',
      `"${canalUrl}/videos"`,
    ].join(' ');

    const saida = execSync(cmd, { encoding: 'utf-8', timeout: 60000 });
    const linhas = saida.trim().split('\n').filter(Boolean);

    return linhas.map(linha => {
      const partes = linha.split('\t');
      const upload_date_str = partes[0] || '';
      const duracao_s = parseInt(partes[1] || '0', 10);
      const url = partes[2] || '';
      const titulo = partes.slice(3).join('\t') || '';
      const upload_date = parseInt(upload_date_str, 10) || 0;

      return { url, titulo, duracao_s, upload_date };
    }).filter(v => v.url && v.url.includes('youtube.com'));

  } catch (err) {
    log(`  ERRO ao listar vídeos de ${canalUrl}: ${err.message.substring(0, 200)}`);
    return [];
  }
}

/**
 * Escolhe o melhor episódio para o podcast:
 * 1. Preferencialmente dentro dos últimos 30 dias + duração >= MIN_DURACAO_S
 * 2. Se não houver, o mais recente com duração >= MIN_DURACAO_S
 * 3. Se não houver, o mais recente de qualquer duração
 */
function escolherEpisodio(videos) {
  if (!videos.length) return null;

  const limite = dataLimite();

  // Opção 1: recente E longo
  const recentesLongos = videos.filter(v => v.upload_date >= limite && v.duracao_s >= MIN_DURACAO_S);
  if (recentesLongos.length) return recentesLongos[0];

  // Opção 2: qualquer longo (mais recente)
  const longos = videos.filter(v => v.duracao_s >= MIN_DURACAO_S);
  if (longos.length) return longos[0];

  // Opção 3: qualquer (mais recente)
  return videos[0];
}

/**
 * Atualiza todos os episodio_url de um podcast_id em um arquivo JSON.
 */
function atualizarCortes(filePath, podcastId, url) {
  const cortes = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  let atualizados = 0;

  for (const corte of cortes) {
    if (corte.podcast_id === podcastId) {
      corte.episodio_url = url;
      atualizados++;
    }
  }

  fs.writeFileSync(filePath, JSON.stringify(cortes, null, 2));
  return atualizados;
}

// ─── Principal ────────────────────────────────────────────────────────────────

async function main() {
  const limiteNum = dataLimite();
  log(`Minerando episódios dos últimos ${DIAS_LIMITE} dias (desde ${limiteNum})...`);
  log(`Mínimo de duração: ${MIN_DURACAO_S / 60} minutos\n`);

  const resultados = {};
  let totalAtualizados = 0;
  let semEpisodio = [];

  for (const podcast of PODCASTS) {
    log(`[${podcast.id}] Buscando vídeos em ${podcast.canal}...`);
    const videos = listarVideos(podcast.canal);
    log(`  Encontrados ${videos.length} vídeos`);

    const escolhido = escolherEpisodio(videos);

    if (!escolhido) {
      log(`  AVISO: nenhum episódio encontrado para ${podcast.id}`);
      semEpisodio.push(podcast.id);
      resultados[podcast.id] = null;
      continue;
    }

    const ageFlag = escolhido.upload_date >= limiteNum ? 'RECENTE' : 'MAIS ANTIGO';
    const duracaoMin = Math.round(escolhido.duracao_s / 60);
    log(`  [${ageFlag}] ${escolhido.url} — "${escolhido.titulo}" (${duracaoMin} min, ${escolhido.upload_date})`);

    resultados[podcast.id] = { url: escolhido.url, titulo: escolhido.titulo, duracao_min: duracaoMin, upload_date: escolhido.upload_date };

    // Atualiza o JSON do nicho correspondente
    const filePath = path.join(DIR, `cortes_plano_${podcast.nicho}.json`);
    if (fs.existsSync(filePath)) {
      const n = atualizarCortes(filePath, podcast.id, escolhido.url);
      log(`  Atualizados ${n} cortes em cortes_plano_${podcast.nicho}.json`);
      totalAtualizados += n;
    }
  }

  log(`\n═══════════════════════════════════════════════════`);
  log(`MINERAÇÃO CONCLUÍDA`);
  log(`Total de cortes atualizados: ${totalAtualizados}`);
  if (semEpisodio.length) {
    log(`Podcasts sem episódio: ${semEpisodio.join(', ')}`);
  }
  log(`═══════════════════════════════════════════════════\n`);

  // Salva mapa de episódios escolhidos para referência
  const mapaPath = path.join(DIR, 'episodios_mapeados.json');
  fs.writeFileSync(mapaPath, JSON.stringify(resultados, null, 2));
  log(`Mapa de episódios salvo em: ${mapaPath}`);
}

main().catch(err => {
  console.error('Erro fatal:', err.message);
  process.exit(1);
});
