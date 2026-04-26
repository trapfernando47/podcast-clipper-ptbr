require("dotenv").config();
const puppeteer = require("puppeteer-core");
const path = require("path");
const fs = require("fs");
const logger = require("./logger");

// Caminho do executável do Chromium (ajustar conforme o sistema)
const CHROMIUM_PATHS = {
  linux: "/usr/bin/chromium-browser",
  linux_alt: "/usr/bin/chromium",
  darwin: "/Applications/Chromium.app/Contents/MacOS/Chromium",
  win32: "C:\\Program Files\\Chromium\\Application\\chrome.exe",
  win32_alt: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
};

function getChromiumPath() {
  const platform = process.platform;
  if (platform === "linux") {
    if (fs.existsSync(CHROMIUM_PATHS.linux)) return CHROMIUM_PATHS.linux;
    return CHROMIUM_PATHS.linux_alt;
  }
  if (platform === "darwin") return CHROMIUM_PATHS.darwin;
  if (platform === "win32") {
    if (fs.existsSync(CHROMIUM_PATHS.win32)) return CHROMIUM_PATHS.win32;
    return CHROMIUM_PATHS.win32_alt;
  }
  return CHROMIUM_PATHS.linux;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function postToTikTok(videoPath, caption, attempt = 1) {
  const executablePath = getChromiumPath();
  if (!fs.existsSync(executablePath)) {
    throw new Error(`Chromium não encontrado em: ${executablePath}. Instale o Chromium ou ajuste o caminho.`);
  }

  const userDataDir = process.env.CHROMIUM_USER_DATA_DIR;
  if (!userDataDir) {
    throw new Error("CHROMIUM_USER_DATA_DIR não configurado no .env");
  }

  logger.info(`[TikTok] Postando vídeo: ${path.basename(videoPath)} (tentativa ${attempt})`);

  const browser = await puppeteer.launch({
    executablePath,
    userDataDir,
    headless: process.env.HEADLESS !== "false", // false para debug, true para produção
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--disable-gpu",
    ],
  });

  const page = await browser.newPage();

  try {
    // Acessar a página de upload do TikTok
    await page.goto("https://www.tiktok.com/upload", { waitUntil: "networkidle2", timeout: 60000 });

    // Aguardar o iframe de upload (TikTok usa iframe para upload)
    await page.waitForSelector('iframe', { timeout: 15000 });
    const iframeElement = await page.$('iframe');
    const iframe = await iframeElement.contentFrame();

    if (!iframe) {
      throw new Error("Não foi possível acessar o iframe de upload do TikTok");
    }

    // Upload do vídeo
    await iframe.waitForSelector('input[type="file"]', { timeout: 15000 });
    const fileInput = await iframe.$('input[type="file"]');
    await fileInput.uploadFile(videoPath);

    // Aguardar o vídeo processar
    logger.info("[TikTok] Aguardando processamento do vídeo...");
    await sleep(8000);

    // Tentar detectar barra de progresso
    try {
      await iframe.waitForSelector(".upload-progress-bar", { timeout: 60000 });
      await iframe.waitForFunction(
        () => !document.querySelector(".upload-progress-bar"),
        { timeout: 120000 }
      );
    } catch {
      logger.warn("[TikTok] Timeout na barra de progresso, continuando...");
    }
    await sleep(3000);

    // Inserir a legenda/descrição
    logger.info("[TikTok] Inserindo legenda...");
    const captionSelectors = [
      '[data-text="true"]',
      '.public-DraftEditor-content',
      '[contenteditable="true"]',
      '.editor-content',
      'div[contenteditable]',
    ];

    let captionInput = null;
    for (const sel of captionSelectors) {
      captionInput = await iframe.$(sel);
      if (captionInput) break;
    }

    if (captionInput) {
      await captionInput.click({ clickCount: 3 });
      await captionInput.type(caption, { delay: 10 });
    } else {
      logger.warn("[TikTok] Campo de legenda não encontrado, tentando via keyboard...");
    }

    await sleep(1000);

    // Clicar em "Publicar"
    logger.info("[TikTok] Clicando em Publicar...");
    const postButtonSelectors = [
      'button[type="submit"]',
      'button:has-text("Post")',
      'button:has-text("Publicar")',
      'button:has-text("Publish")',
      '.btn-post',
      '[data-e2e="post_video_button"]',
    ];

    let posted = false;
    for (const sel of postButtonSelectors) {
      try {
        const btn = await iframe.$(sel);
        if (btn) {
          await btn.click();
          posted = true;
          break;
        }
      } catch {
        // tentar próximo seletor
      }
    }

    if (!posted) {
      // Fallback: procurar botão por texto
      const buttons = await iframe.$$('button');
      for (const btn of buttons) {
        const text = await btn.evaluate(el => el.textContent);
        if (/post|publicar|publish/i.test(text)) {
          await btn.click();
          posted = true;
          break;
        }
      }
    }

    if (!posted) {
      throw new Error("Botão de publicar não encontrado");
    }

    // Aguardar confirmação
    await sleep(5000);
    logger.info(`[TikTok] Vídeo postado com sucesso: ${path.basename(videoPath)}`);
    return true;
  } catch (err) {
    logger.error(err, { context: "postToTikTok", attempt, videoPath });
    if (attempt < 2) {
      await browser.close();
      await sleep(5000);
      return postToTikTok(videoPath, caption, attempt + 1);
    }
    throw err;
  } finally {
    await browser.close();
  }
}

async function schedulePostings(videoPaths, captions, dateStr) {
  // Horários de pico: 9h, 12h, 18h
  const scheduleHours = [9, 12, 18];
  const now = new Date();
  const targetDate = new Date(dateStr);

  for (let i = 0; i < Math.min(videoPaths.length, captions.length, 3); i++) {
    const videoPath = videoPaths[i];
    const caption = captions[i];
    const hour = scheduleHours[i];

    const postTime = new Date(targetDate);
    postTime.setHours(hour, 0, 0, 0);

    // Se o horário já passou hoje, postar imediatamente (ou agendar para amanhã se preferir)
    if (postTime <= now) {
      logger.info(`[TikTok] Horário ${hour}h já passou, postando imediatamente...`);
      await postToTikTok(videoPath, caption);
    } else {
      const delayMs = postTime - now;
      logger.info(`[TikTok] Agendado para ${hour}h (${Math.round(delayMs / 1000 / 60)} min)`);
      await sleep(delayMs);
      await postToTikTok(videoPath, caption);
    }

    // Delay entre postagens
    if (i < videoPaths.length - 1) await sleep(3000);
  }
}

// Teste standalone
if (require.main === module) {
  const [, , videoPath, caption] = process.argv;
  if (!videoPath || !caption) {
    console.error("Uso: node tiktokPoster.js <videoPath> <caption>");
    process.exit(1);
  }
  postToTikTok(videoPath, caption)
    .then(() => {
      console.log("✅ Postado com sucesso!");
      process.exit(0);
    })
    .catch(err => {
      console.error("❌ Erro:", err);
      process.exit(1);
    });
}

module.exports = { postToTikTok, schedulePostings };
