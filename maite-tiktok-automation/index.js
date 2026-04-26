require("dotenv").config();
const cron = require("node-cron");
const path = require("path");
const fs = require("fs");
const { generateAllImages } = require("./modules/imageGenerator");
const { mineAndDownloadVideos } = require("./modules/videoMiner");
const { generateKlingVideos } = require("./modules/videoGenerator");
const { getDailyCaptions } = require("./modules/captionGenerator");
const { schedulePostings } = require("./modules/tiktokPoster");
const logger = require("./modules/logger");

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runDailyAutomation(dateStr) {
  logger.info("═══════════════════════════════════════════════");
  logger.info("  🚀 MAITE AUTOMATION — INICIANDO EXECUÇÃO DIÁRIA");
  logger.info("═══════════════════════════════════════════════");

  const outputDir = path.join(process.env.OUTPUT_DIR || "./output", dateStr);

  // Criar diretórios do dia
  fs.mkdirSync(path.join(outputDir, "images"), { recursive: true });
  fs.mkdirSync(path.join(outputDir, "videos-referencia"), { recursive: true });
  fs.mkdirSync(path.join(outputDir, "videos-finais"), { recursive: true });

  let generatedImages = [];
  let referenceVideos = [];
  let finalVideos = [];
  let captions = [];

  try {
    // ─── PARTE 1: Gerar imagens ───────────────────────────────────────────────
    logger.info("📸 [PARTE 1] Gerando imagens via Replicate...");
    generatedImages = await generateAllImages(dateStr, outputDir);
    logger.info(`✅ [PARTE 1] ${generatedImages.length} imagens geradas com sucesso!`);
  } catch (error) {
    logger.error(error, { context: "PARTE 1 - imageGenerator" });
    logger.warn("[PARTE 1] Continuando sem imagens geradas. O sistema não pode prosseguir sem imagens.");
    return { success: false, error: error.message, stage: "images" };
  }

  try {
    // ─── PARTE 2: Minerar e baixar vídeos virais ──────────────────────────────
    logger.info("🎬 [PARTE 2] Minerando vídeos virais do TikTok...");
    referenceVideos = await mineAndDownloadVideos(dateStr, outputDir);
    logger.info(`✅ [PARTE 2] ${referenceVideos.length} vídeos de referência baixados!`);
  } catch (error) {
    logger.error(error, { context: "PARTE 2 - videoMiner" });
    logger.warn("[PARTE 2] Continuando sem vídeos de referência. O sistema não pode prosseguir sem vídeos.");
    return { success: false, error: error.message, stage: "videos" };
  }

  try {
    // ─── PARTE 3A: Gerar vídeos finais com Kling 2.6 ─────────────────────────
    logger.info("🎥 [PARTE 3] Gerando vídeos finais via Freepik Kling 2.6...");
    finalVideos = await generateKlingVideos(generatedImages, referenceVideos, outputDir);
    logger.info(`✅ [PARTE 3] ${finalVideos.length} vídeos finais gerados!`);
  } catch (error) {
    logger.error(error, { context: "PARTE 3A - videoGenerator" });
    logger.warn("[PARTE 3A] Continuando sem vídeos finais. O sistema não pode prosseguir sem vídeos finais.");
    return { success: false, error: error.message, stage: "finalVideos" };
  }

  try {
    // ─── LEGENDAS ─────────────────────────────────────────────────────────────
    captions = getDailyCaptions(dateStr);
    logger.info("📝 Legendas geradas:");
    captions.forEach((c, i) => logger.info(`  Vídeo ${i + 1}: ${c}`));
  } catch (error) {
    logger.error(error, { context: "Legendas" });
    captions = [
      "Just being myself 💫 #viral #trend #dance #tiktokviral #fyp",
      "This mood 💅 #fyp #viral #mood #trend #aesthetic",
      "Feeling this energy today ✨ #fyp #viral #mood #aesthetic #trend",
    ];
    logger.warn("[Legendas] Usando legendas padrão de fallback");
  }

  try {
    // ─── PARTE 3B: Agendar postagens nos horários de pico ─────────────────────
    logger.info("📅 [POSTAGEM] Agendando postagens para 9h, 12h e 18h...");
    await schedulePostings(finalVideos, captions, dateStr);
    logger.info("✅ Postagens agendadas com sucesso!");
  } catch (error) {
    logger.error(error, { context: "PARTE 3B - tiktokPoster" });
    return { success: false, error: error.message, stage: "posting" };
  }

  logger.info("═══════════════════════════════════════════════");
  logger.info("  ✅ MAITE AUTOMATION — EXECUÇÃO DIÁRIA CONCLUÍDA");
  logger.info("═══════════════════════════════════════════════");

  return { success: true, images: generatedImages, videos: finalVideos, captions };
}

// ─── CRON: Executar todos os dias às 7h da manhã ──────────────────────────────
cron.schedule("0 7 * * *", async () => {
  const today = new Date().toISOString().split("T")[0];
  await runDailyAutomation(today);
}, {
  timezone: "America/Sao_Paulo",
  scheduled: true,
});

logger.info("⏰ Maite Automation ativa! Aguardando execução às 7h (horário de Brasília)...");
logger.info("💡 Para testar agora, execute: node index.js --test\n");

// Modo de teste (executar imediatamente sem esperar o cron)
if (process.argv.includes("--test")) {
  (async () => {
    logger.info("🧪 MODO TESTE — executando imediatamente...");
    const today = new Date().toISOString().split("T")[0];
    const result = await runDailyAutomation(today);
    process.exit(result.success ? 0 : 1);
  })();
}

module.exports = { runDailyAutomation };
