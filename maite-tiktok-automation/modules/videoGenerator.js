require("dotenv").config();
const axios = require("axios");
const FormData = require("form-data");
const fs = require("fs");
const path = require("path");
const logger = require("./logger");

const KLING_PROMPT = `A young blonde woman with long straight hair. She performs the exact same movements and timing as the reference video, accurately copying pose transitions, body rhythm, subtle hip sway, torso movement, shoulder motion, head turns, arm gestures, hand relaxation, posture adjustments, and gaze direction. Movements must appear extremely natural, soft, smooth, elegant, and realistic. Include gentle breathing, believable weight shifts, subtle hair sway, slight clothing movement, body language, and realistic facial micro-expressions. Preserve her identity, facial features, body proportions, accessories, skin texture, clothing details, and bedroom environment. Lighting remains soft and consistent, background unchanged throughout the scene.`;

const KLING_NEGATIVE_PROMPT = `camera movement, moving camera, camera shake, camera pan, camera tilt, camera zoom, zoom in, zoom out, dolly in, dolly out, orbit camera, handheld camera, tracking shot, cinematic camera motion, perspective shift, lens movement, frame drift, unstable frame, floating camera, dynamic camera, rolling shutter, jitter, vibration, wobble, any camera motion whatsoever, absolutely no camera movement, camera must remain fully static, camera completely locked, static frame only, locked frame only, fixed tripod only, zero camera motion, no camera repositioning, no lens motion, background movement, body distortion, warped anatomy, broken limbs, robotic movement, stiff animation, unnatural motion, exaggerated motion blur`;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function uploadFile(filePath, apiKey) {
  const form = new FormData();
  form.append("file", fs.createReadStream(filePath));

  const response = await axios.post(
    "https://api.freepik.com/v1/resources/upload",
    form,
    {
      headers: {
        ...form.getHeaders(),
        "x-freepik-api-key": apiKey,
      },
      timeout: 60000,
    }
  );

  return response.data.data.id;
}

async function generateKlingVideo(imagePath, referenceVideoPath, outputPath, attempt = 1) {
  const FREEPIK_API_KEY = process.env.FREEPIK_API_KEY;

  logger.info(`[Freepik] Iniciando geração Kling 2.6: ${path.basename(outputPath)} (tentativa ${attempt})`);

  try {
    // 1. Upload da imagem de referência
    logger.info(`[Freepik] Upload imagem: ${path.basename(imagePath)}`);
    const imageId = await uploadFile(imagePath, FREEPIK_API_KEY);
    await sleep(2000);

    // 2. Upload do vídeo de referência
    logger.info(`[Freepik] Upload vídeo: ${path.basename(referenceVideoPath)}`);
    const videoId = await uploadFile(referenceVideoPath, FREEPIK_API_KEY);
    await sleep(2000);

    // 3. Criar job de geração de vídeo com Kling 2.6 Motion Control
    logger.info(`[Freepik] Criando job Kling 2.6...`);
    const jobResponse = await axios.post(
      "https://api.freepik.com/v1/ai/video/kling/motion-control",
      {
        prompt: KLING_PROMPT,
        negative_prompt: KLING_NEGATIVE_PROMPT,
        image_id: imageId,
        reference_video_id: videoId,
        model: "kling-v2.6",
        motion_control: {
          type: "reference_video",
          strength: 0.94,
          follow_reference_pose: 1.0,
          timing_accuracy: 1.0,
          smoothness: 0.99,
          naturalness: 1.0,
        },
        style: "photorealistic, ultra realistic, high detail, realistic skin texture, natural indoor lighting, sharp clean focus",
        camera: {
          static: true,
          lock_position: true,
          no_movement: true,
          tripod_fixed: true,
          frame_locked: true,
          zero_camera_motion: true,
          fully_static_camera: true,
          camera_completely_locked: true,
        },
        duration: 5,
        aspect_ratio: "9:16",
      },
      {
        headers: {
          "x-freepik-api-key": FREEPIK_API_KEY,
          "Content-Type": "application/json",
        },
        timeout: 30000,
      }
    );

    const jobId = jobResponse.data.data.id;
    logger.info(`[Freepik] Job criado: ${jobId}`);

    // 4. Polling até o vídeo ficar pronto
    let videoUrl = null;
    let attempts = 0;
    const maxAttempts = 120; // máximo 20 minutos (a cada 10s)

    while (attempts < maxAttempts) {
      await sleep(10000);

      const statusResponse = await axios.get(
        `https://api.freepik.com/v1/ai/video/kling/motion-control/${jobId}`,
        {
          headers: { "x-freepik-api-key": FREEPIK_API_KEY },
          timeout: 15000,
        }
      );

      const status = statusResponse.data.data.status;

      if (status === "completed" || status === "succeeded") {
        videoUrl = statusResponse.data.data.output_url || statusResponse.data.data.video_url;
        break;
      } else if (status === "failed" || status === "error") {
        throw new Error(`Kling job ${jobId} falhou: ${JSON.stringify(statusResponse.data)}`);
      }

      attempts++;
      if (attempts % 6 === 0) {
        logger.info(`[Kling] Job ${jobId} - status: ${status} (tentativa ${attempts}/${maxAttempts})`);
      }
    }

    if (!videoUrl) throw new Error(`Timeout aguardando vídeo Kling job ${jobId}`);

    // 5. Baixar o vídeo gerado
    logger.info(`[Freepik] Download vídeo gerado: ${videoUrl}`);
    const videoResponse = await axios.get(videoUrl, {
      responseType: "arraybuffer",
      timeout: 120000,
    });
    fs.writeFileSync(outputPath, Buffer.from(videoResponse.data));

    logger.info(`[Freepik] Vídeo salvo: ${outputPath}`);
    return outputPath;
  } catch (err) {
    logger.error(err, { context: "generateKlingVideo", attempt, outputPath });
    if (attempt < 2) {
      logger.warn(`[Freepik] Retry em 10s...`);
      await sleep(10000);
      return generateKlingVideo(imagePath, referenceVideoPath, outputPath, attempt + 1);
    }
    throw err;
  }
}

async function generateKlingVideos(imagePaths, videoPaths, outputDir) {
  const videosDir = path.join(outputDir, "videos-finais");
  fs.mkdirSync(videosDir, { recursive: true });

  const results = [];
  const count = Math.min(imagePaths.length, videoPaths.length, 3);

  for (let i = 0; i < count; i++) {
    const outputPath = path.join(videosDir, `final_video_${i + 1}.mp4`);
    try {
      const result = await generateKlingVideo(imagePaths[i], videoPaths[i], outputPath);
      results.push(result);
      // Rate limit: aguardar 5s entre jobs
      if (i < count - 1) await sleep(5000);
    } catch (err) {
      logger.error(err, { context: "generateKlingVideos", index: i });
      if (results.length === 0 && i === count - 1) {
        throw new Error("Todas as gerações de vídeo falharam");
      }
    }
  }

  return results;
}

// Teste standalone
if (require.main === module) {
  (async () => {
    try {
      // Requer argumentos: node videoGenerator.js <imagePath> <videoPath> <outputPath>
      const [, , imagePath, videoPath, outputPath] = process.argv;
      if (!imagePath || !videoPath || !outputPath) {
        console.error("Uso: node videoGenerator.js <imagePath> <videoPath> <outputPath>");
        process.exit(1);
      }
      const result = await generateKlingVideo(imagePath, videoPath, outputPath);
      console.log("✅ Vídeo gerado:", result);
      process.exit(0);
    } catch (err) {
      console.error("❌ Erro:", err);
      process.exit(1);
    }
  })();
}

module.exports = { generateKlingVideos, generateKlingVideo };
