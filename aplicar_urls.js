'use strict';

/**
 * aplicar_urls.js
 *
 * Aplica as URLs mineradas do YouTube nos arquivos cortes_plano_*.json.
 * Podcasts sem canal ativo foram substituídos por programas brasileiros equivalentes
 * com conteúdo temático compatível.
 */

const fs = require('fs');
const path = require('path');

const DIR = __dirname;

// ─── Mapa de URLs mineradas ───────────────────────────────────────────────────
// podcast_id → { url, titulo, canal, substituto }
const EPISODIOS = {
  // ── Finanças ──────────────────────────────────────────────────────────────
  'primo-rico': {
    url: 'https://www.youtube.com/watch?v=a2VGFb_aWTc',
    titulo: 'O GRANDE RESET FINANCEIRO MUNDIAL: TUDO ESTÁ PRESTES A MUDAR (Se prepare)',
    canal: 'O Primo Rico',
    substituto: false,
  },
  'me-poupe': {
    url: 'https://www.youtube.com/watch?v=OBY3pX0xRBA',
    titulo: 'Dinheiro Em 2026: Descubra Os Signos Que Vão Prosperar (E Os Que Devem Tomar Cuidado) #89 com Ana Leo',
    canal: 'Me Poupe!',
    substituto: false,
  },
  'market-makers': {
    url: 'https://www.youtube.com/watch?v=tAssHJzCw6s',
    titulo: 'SEGREDOS DE INVESTIMENTO DE UMA DAS MENTES MAIS BRILHANTES DO MERCADO | Market Makers #223',
    canal: 'Market Makers',
    substituto: false,
  },
  'stock-pickers': {
    url: 'https://www.youtube.com/watch?v=rbOYB91BkDk',
    titulo: 'AS DUAS GUERRAS DE TRÓIA E O OURO COMO ESCUDO: PREVISÕES DE 2026, POR RUY ALVES DA KINEA',
    canal: 'Stock Pickers',
    substituto: false,
  },
  'jornada-dinheiro': {
    // Canal @jornadododinheiro inativo/404 — substituído por Os Sócios Podcast (investimentos 2026)
    url: 'https://www.youtube.com/watch?v=TkliXL0Inws',
    titulo: 'AS MELHORES OPORTUNIDADES DE INVESTIMENTOS PARA 2026: RENDA FIXA, AÇÕES e ECONOMIA | Os Sócios 273',
    canal: 'Os Sócios Podcast',
    substituto: true,
  },

  // ── Saúde ─────────────────────────────────────────────────────────────────
  'flow-podcast': {
    url: 'https://www.youtube.com/watch?v=Am98L1HQRkY',
    titulo: 'ANDRÉA VERMONT - Flow #520',
    canal: 'Flow Podcast',
    substituto: false,
  },
  'inteligencia-ltda': {
    url: 'https://www.youtube.com/watch?v=5yPjYQLpoOY',
    titulo: 'A BANALIZAÇÃO DAS DOENÇAS MENTAIS: GUIDO PALOMBA - Inteligência Ltda. Podcast #1499',
    canal: 'Inteligência Ltda',
    substituto: false,
  },
  'cana-podcast': {
    // Canal @canapodcast inativo/404 — substituído por Os Sócios com Renato Cariani (nutrição/performance)
    url: 'https://www.youtube.com/watch?v=rJXr365HbY0',
    titulo: 'COMO QUEIMAR GORDURA E GANHAR MASSA MUSCULAR (Renato Cariani e Julio Balestrin) | Os Sócios 258',
    canal: 'Os Sócios Podcast',
    substituto: true,
  },
  'podpah-saude': {
    url: 'https://www.youtube.com/watch?v=MDVFOjkqHeA',
    titulo: 'OS MAIORES NOMES DA INTERNET REUNIDOS NA CASA DO PODPAH DE VERÃO - Podpah de Verão 2026',
    canal: 'Podpah',
    substituto: false,
  },
  'longevidade-em-foco': {
    // Canal @longevidadeemfoco com poucos vídeos — substituído por Dr. Renato Tomioka (ciência da longevidade)
    url: 'https://www.youtube.com/watch?v=EALahwS2-Dk',
    titulo: 'The Science of Discomfort: Fasting, Metabolism & Longevity | Dr. Renato Tomioka & Dra. Maíra Soliani',
    canal: 'Dr. Renato Tomioka, MD, PhD',
    substituto: true,
  },

  // ── Carreira ──────────────────────────────────────────────────────────────
  'startse-podcast': {
    // Canal @startse retornando conteúdo incorreto — substituído por O Conselho Flávio Augusto (IA/negócios)
    url: 'https://www.youtube.com/watch?v=a1MVf8eGlG8',
    titulo: 'COMO INTELIGÊNCIA ARTIFICIAL VAI QUEBRAR SEU NEGÓCIO SE VOCÊ NÃO OLHAR PARA ISSO | O Conselho 27',
    canal: 'O Conselho | Flávio Augusto',
    substituto: true,
  },
  'cafe-com-adm': {
    url: 'https://www.youtube.com/watch?v=DDYKwDFK29A',
    titulo: 'Leadership: How to Become an Indispensable Executive, with Rodrigo Araújo | Coffee with ADM 490',
    canal: 'Portal Administradores / Café com ADM',
    substituto: false,
  },
  'nerdcast': {
    url: 'https://www.youtube.com/watch?v=QT09SehO2zM',
    titulo: 'NerdCast 1026 - Artemis II: A Nova Era da Humanidade na Lua',
    canal: 'Jovem Nerd',
    substituto: false,
  },
  'tribo-de-experts': {
    url: 'https://www.youtube.com/watch?v=3LylHrGA56c',
    titulo: '9 Atitudes Para Ter Sucesso em 2026 (JOEL JOTA) | JOTA JOTA PODCAST #259',
    canal: 'Joel Jota',
    substituto: false,
  },
  'digital-talks': {
    // Canal @digitaltalks sem aba de vídeos — substituído por Os Sócios (estratégias de marketing digital 2026)
    url: 'https://www.youtube.com/watch?v=EkXmnFur8Hg',
    titulo: 'ESTRATÉGIAS DE MARKETING DIGITAL PARA 2026 (Duda Vieira, Isabela Matte e Luan Assis) | Os Sócios 292',
    canal: 'Os Sócios Podcast',
    substituto: true,
  },
};

function log(msg) {
  process.stdout.write(`[${new Date().toISOString()}] ${msg}\n`);
}

function aplicarUrls(nicho) {
  const filePath = path.join(DIR, `cortes_plano_${nicho}.json`);
  if (!fs.existsSync(filePath)) {
    log(`AVISO: ${filePath} não encontrado`);
    return 0;
  }

  const cortes = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  let atualizados = 0;
  let ignorados = 0;

  for (const corte of cortes) {
    const ep = EPISODIOS[corte.podcast_id];
    if (!ep) {
      log(`  AVISO: sem mapeamento para podcast_id="${corte.podcast_id}"`);
      ignorados++;
      continue;
    }
    corte.episodio_url = ep.url;
    atualizados++;
  }

  fs.writeFileSync(filePath, JSON.stringify(cortes, null, 2));
  log(`  cortes_plano_${nicho}.json: ${atualizados} cortes atualizados${ignorados ? ` | ${ignorados} sem mapeamento` : ''}`);
  return atualizados;
}

function main() {
  log('Aplicando URLs nos planos de cortes...\n');

  log('EPISÓDIOS MAPEADOS:');
  for (const [podId, ep] of Object.entries(EPISODIOS)) {
    const flag = ep.substituto ? '[SUBSTITUTO]' : '[ORIGINAL]  ';
    log(`  ${flag} ${podId.padEnd(22)} → ${ep.url}`);
  }
  log('');

  let total = 0;
  for (const nicho of ['financas', 'saude', 'carreira']) {
    total += aplicarUrls(nicho);
  }

  // Atualiza também o arquivo de mapa de episódios
  const mapaPath = path.join(DIR, 'episodios_mapeados.json');
  fs.writeFileSync(mapaPath, JSON.stringify(EPISODIOS, null, 2));

  log(`\n═══════════════════════════════════════════════════`);
  log(`CONCLUÍDO: ${total} cortes atualizados com URLs reais`);
  log(`Substitutos usados: ${Object.values(EPISODIOS).filter(e => e.substituto).length} de 15 podcasts`);
  log(`═══════════════════════════════════════════════════`);
}

main();
