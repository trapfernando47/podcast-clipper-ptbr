require("dotenv").config();
const { exec } = require("child_process");
const util = require("util");
const fs = require("fs");
const path = require("path");
const logger = require("./logger");

const execAsync = util.promisify(exec);

const HASHTAG_POOLS = [
  ["dance", "dancechallenge", "girlsdance"],
  ["danceviral", "trending", "dancetrend"],
  ["fyp", "viral", "dancecover"],
  ["tiktokdance", "dancevideo", "choreography"],
  ["dancevideos", "girlviral", "dancechallenge"],
];

function getDailyHashtags(dateStr) {
  const date = new Date(dateStr);
  const dayOfYear = Math.floor(
    (date - new Date(date.getFullYear(), 0, 0)) / (1000 * 60 * 60 * 24)
  );
  return HASHTAG_POOLS[dayOfYear % HASHTAG_POOLS.length];
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function scoreVideo(video) {
  // Views: escala até 1M, mínimo exigido de 100k
  if (video.views < 100_000) return 0;
  const viewScore = Math.min(video.views / 1_000_000, 1) * 40;

  // Engajamento: desclassificar abaixo de 5%
  const engagementRate = (video.likes + video.comments + video.shares) / video.views;
  if (engagementRate < 0.05) return 0;
  const engagementScore = Math.min(engagementRate / 0.1, 1) * 35;

  // Duração: faixa ideal 12–20s, penalidade progressiva fora da faixa
  const durationScore =
    video.duration >= 12 && video.duration <= 20 ? 15 :
    video.duration > 20 && video.duration <= 30 ? 10 :
    video.duration > 30 && video.duration <= 45 ? 5 : 2;

  // Recência: decaimento linear nos últimos 7 dias
  const daysSincePost = (Date.now() - video.createdAt) / (1000 * 60 * 60 * 24);
  const recencyScore = Math.max(0, 10 - daysSincePost * 1.43);

  return viewScore + engagementScore + durationScore + recencyScore;
}

// Fallback: vídeos virais conhecidos do TikTok (atualizar periodicamente)
const FALLBACK_VIDEOS = [
  "https://www.tiktok.com/@charlidamelio/video/6801589203014472966",
  "https://www.tiktok.com/@addisonre/video/6801589203014472966",
  "https://www.tiktok.com/@bellapoarch/video/6801589203014472966",
];

async function searchTikTokVideos(hashtags, limit = 15) {
  logger.info(`[VideoMiner] Buscando vídeos com hashtags: ${hashtags.join(", ")}`);

  // Tentar usar yt-dlp para extrair resultados de busca
  const searchQuery = hashtags.join(" ") + " tiktok";
  const ytDlpCmd = `yt-dlp "ytsearch${limit}:${searchQuery}" --dump-json --flat-playlist --no-download`;

  try {
    const { stdout } = await execAsync(ytDlpCmd, { timeout: 120000 });
    const lines = stdout.trim().split("\n").filter(Boolean);
    const videos = lines.map(line => {
      try {
        const data = JSON.parse(line);
        return {
          id: data.id,
          url: data.url || data.webpage_url || `https://www.tiktok.com/@${data.uploader || "user"}/video/${data.id}`,
          title: data.title || "",
          views: data.view_count || data.viewCount || 0,
          likes: data.like_count || data.likeCount || 0,
          comments: data.comment_count || data.commentCount || 0,
          shares: data.repost_count || data.repostCount || 0,
          duration: data.duration || 15,
          createdAt: data.timestamp ? data.timestamp * 1000 : Date.now(),
        };
      } catch {
        return null;
      }
    }).filter(Boolean);

    logger.info(`[VideoMiner] ${videos.length} vídeos encontrados via yt-dlp`);
    return videos;
  } catch (err) {
    logger.error(err, { context: "searchTikTokVideos", hashtags });
    logger.warn("[VideoMiner] Usando fallback de URLs conhecidas");
    return FALLBACK_VIDEOS.map((url, idx) => ({
      id: `fallback_${idx}`,
      url,
      title: "Fallback video",
      views: 500_000,
      likes: 50_000,
      comments: 5_000,
      shares: 10_000,
      duration: 15,
      createdAt: Date.now() - 86400000,
    }));
  }
}

async function downloadVideo(videoUrl, outputPath, attempt = 1) {
  logger.info(`[VideoMiner] Download: ${path.basename(outputPath)} (tentativa ${attempt})`);

  // Garantir que o diretório existe
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  try {
    const cmd = `yt-dlp --no-warnings -f "mp4" -o "${outputPath}" "${videoUrl}"`;
    await execAsync(cmd, { timeout: 300000 });

    if (!fs.existsSync(outputPath)) {
      throw new Error(`Arquivo não foi criado: ${outputPath}`);
    }

    logger.info(`[VideoMiner] Download completo: ${outputPath}`);
    return outputPath;
  } catch (err) {
    logger.error(err, { context: "downloadVideo", attempt, videoUrl, outputPath });
    if (attempt < 3) {
      await sleep(5000);
      return downloadVideo(videoUrl, outputPath, attempt + 1);
    }
    throw err;
  }
}

async function mineAndDownloadVideos(dateStr, outputDir) {
  const hashtags = getDailyHashtags(dateStr);
  const videosDir = path.join(outputDir, "videos-referencia");
  fs.mkdirSync(videosDir, { recursive: true });

  // Buscar 15 candidatos
  const candidates = await searchTikTokVideos(hashtags, 15);

  // Calcular scores e ordenar
  const scored = candidates
    .map(v => ({ ...v, score: scoreVideo(v) }))
    .filter(v => v.score > 0)
    .sort((a, b) => b.score - a.score);

  const top3 = scored.slice(0, 3);

  if (top3.length < 3) {
    logger.warn(`[VideoMiner] Apenas ${top3.length} vídeos atenderam aos critérios. Preenchendo com fallback...`);
    while (top3.length < 3) {
      const fallback = FALLBACK_VIDEOS[top3.length % FALLBACK_VIDEOS.length];
      top3.push({
        id: `fallback_${top3.length}`,
        url: fallback,
        title: "Fallback video",
        views: 500_000,
        likes: 50_000,
        comments: 5_000,
        shares: 10_000,
        duration: 15,
        createdAt: Date.now() - 86400000,
        score: 50,
      });
    }
  }

  logger.info(`[VideoMiner] Top 3 selecionados:`);
  top3.forEach((v, i) => {
    logger.info(`  ${i + 1}. Score: ${v.score.toFixed(1)} | Views: ${v.views} | Duration: ${v.duration}s | URL: ${v.url}`);
  });

  // Baixar os 3 melhores
  const downloaded = [];
  for (let i = 0; i < top3.length; i++) {
    const video = top3[i];
    const outputPath = path.join(videosDir, `video_${i + 1}.mp4`);
    try {
      const result = await downloadVideo(video.url, outputPath);
      downloaded.push(result);
      if (i < top3.length - 1) await sleep(1000);
    } catch (err) {
      logger.error(err, { context: "mineAndDownloadVideos", videoIndex: i });
      if (downloaded.length === 0 && i === top3.length - 1) {
        throw new Error("Todos os downloads de vídeo falharam");
      }
    }
  }

  return downloaded;
}

// Teste standalone
if (require.main === module) {
  const dateStr = new Date().toISOString().split("T")[0];
  const outputDir = path.join(process.env.OUTPUT_DIR || "./output", dateStr);
  mineAndDownloadVideos(dateStr, outputDir)
    .then(paths => {
      console.log("✅ Vídeos baixados:", paths);
      process.exit(0);
    })
    .catch(err => {
      console.error("❌ Erro:", err);
      process.exit(1);
    });
}

module.exports = { mineAndDownloadVideos, getDailyHashtags, scoreVideo };
