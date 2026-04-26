require("dotenv").config();
const Replicate = require("replicate");
const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");
const logger = require("./logger");

const COLOR_PALETTES = [
  { outfit1: "red and white", outfit2: "red floral dress", outfit3: "red gym outfit" },
  { outfit1: "pink and black", outfit2: "pink floral dress", outfit3: "pink gym outfit" },
  { outfit1: "lilac and white", outfit2: "lilac floral dress", outfit3: "purple gym outfit" },
  { outfit1: "orange and white", outfit2: "orange floral dress", outfit3: "orange gym outfit" },
  { outfit1: "yellow and denim", outfit2: "yellow floral dress", outfit3: "yellow gym outfit" },
  { outfit1: "mint green and white", outfit2: "green floral dress", outfit3: "mint green gym outfit" },
  { outfit1: "navy blue and white", outfit2: "navy blue dress", outfit3: "navy blue gym outfit" },
];

function getDailyPalette(dateStr) {
  const date = new Date(dateStr);
  const dayOfYear = Math.floor(
    (date - new Date(date.getFullYear(), 0, 0)) / (1000 * 60 * 60 * 24)
  );
  return COLOR_PALETTES[dayOfYear % COLOR_PALETTES.length];
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function generateImage(referenceImagePath, prompt, outputPath, attempt = 1) {
  const replicate = new Replicate({ auth: process.env.REPLICATE_API_KEY });

  logger.info(`[Replicate] Gerando imagem (tentativa ${attempt}): ${path.basename(outputPath)}`);

  const imageBuffer = fs.readFileSync(referenceImagePath);
  const base64Image = `data:image/jpeg;base64,${imageBuffer.toString("base64")}`;

  try {
    const output = await replicate.run("google/nano-banana-2", {
      input: {
        image: base64Image,
        prompt: prompt,
      },
    });

    // output pode ser uma URL ou array de URLs dependendo do modelo
    const imageUrl = Array.isArray(output) ? output[0] : output;

    if (!imageUrl || typeof imageUrl !== "string") {
      throw new Error(`Resposta inesperada do Replicate: ${JSON.stringify(output)}`);
    }

    // Baixar e salvar a imagem
    const response = await fetch(imageUrl);
    if (!response.ok) {
      throw new Error(`Falha ao baixar imagem: ${response.status} ${response.statusText}`);
    }
    const buffer = await response.buffer();
    fs.writeFileSync(outputPath, buffer);

    logger.info(`[Replicate] Imagem salva: ${outputPath}`);
    return outputPath;
  } catch (err) {
    logger.error(err, { context: "generateImage", attempt, outputPath });
    if (attempt < 3) {
      logger.warn(`[Replicate] Retry em 5s...`);
      await sleep(5000);
      return generateImage(referenceImagePath, prompt, outputPath, attempt + 1);
    }
    throw err;
  }
}

async function generateAllImages(dateStr, outputDir) {
  const referenceImagePath = process.env.REFERENCE_IMAGE_PATH;
  if (!fs.existsSync(referenceImagePath)) {
    throw new Error(`Imagem de referência não encontrada: ${referenceImagePath}`);
  }

  const palette = getDailyPalette(dateStr);
  const imagesDir = path.join(outputDir, "images");
  fs.mkdirSync(imagesDir, { recursive: true });

  const prompts = [
    `Change only the colors of the model's outfit to ${palette.outfit1} colors. Keep the model's exact pose, position, body, face, hair, accessories, and background completely unchanged. Only modify the clothing colors.`,
    `Replace the model's outfit with a casual ${palette.outfit2}, keeping her exact pose, position, body proportions, face, long blonde hair, gold necklace, gold bracelets, and bedroom background completely unchanged. Only change the clothing to a casual floral dress.`,
    `Replace the model's outfit with a ${palette.outfit3} (sports bra crop top and matching leggings), keeping her exact pose, position, body proportions, face, long blonde hair, gold necklace, gold bracelets, and bedroom background completely unchanged. Only change the clothing to gym/athletic wear.`,
  ];

  const results = [];
  for (let i = 0; i < prompts.length; i++) {
    const outputPath = path.join(imagesDir, `image_${i + 1}.jpg`);
    try {
      const result = await generateImage(referenceImagePath, prompts[i], outputPath);
      results.push(result);
      // Rate limit: aguardar 2s entre chamadas
      if (i < prompts.length - 1) await sleep(2000);
    } catch (err) {
      logger.error(err, { context: "generateAllImages", imageIndex: i });
      // Continuar com o que está disponível, mas registrar o erro
      // Se todas falharem, propagar o erro
      if (results.length === 0 && i === prompts.length - 1) {
        throw new Error("Todas as gerações de imagem falharam");
      }
    }
  }

  return results;
}

// Teste standalone
if (require.main === module) {
  const dateStr = new Date().toISOString().split("T")[0];
  const outputDir = path.join(process.env.OUTPUT_DIR || "./output", dateStr);
  generateAllImages(dateStr, outputDir)
    .then(paths => {
      console.log("✅ Imagens geradas:", paths);
      process.exit(0);
    })
    .catch(err => {
      console.error("❌ Erro:", err);
      process.exit(1);
    });
}

module.exports = { generateAllImages, getDailyPalette };
