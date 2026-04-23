require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');

const app = express();
app.use(express.json({ limit: '15mb' }));

const TEMP_DIR = path.join(__dirname, 'temp');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR);

app.use('/temp', express.static(TEMP_DIR));
app.use(express.static(path.join(__dirname, 'public')));

const BASE_URL = process.env.BASE_URL || 'https://restaurantes.onrender.com';

const PROMPT = `Professional AI restoration and ultra-high-definition 8K upscale of an old photograph. Enhance all textures, sharpen blurry edges, and recover lost details from the original reference. Remove all noise, film grain, scratches, and dust. Apply vibrant, natural color correction while maintaining the original composition. Crystal clear, photorealistic, and sharp focus. Restore faces with high fidelity. Make it look like a modern high quality photograph.`;

const NEGATIVE = `blurry, noisy, grainy, damaged, scratched, faded, low quality, ugly, distorted`;

function cleanup(file) {
  try { if (file && fs.existsSync(file)) fs.unlinkSync(file); } catch(e) {}
}

app.post('/api/restaurar', async (req, res) => {
  let tempFile = null;
  try {
    const { image } = req.body;
    if (!image) return res.json({ sucesso: false, erro: 'Imagem nao recebida.' });

    const base64   = image.replace(/^data:image\/\w+;base64,/, '');
    const fileName = crypto.randomBytes(16).toString('hex') + '.jpg';
    tempFile       = path.join(TEMP_DIR, fileName);
    fs.writeFileSync(tempFile, Buffer.from(base64, 'base64'));
    const imageUrl = `${BASE_URL}/temp/${fileName}`;
    console.log('URL publica:', imageUrl);

    const createRes = await axios.post(
      'https://api.kie.ai/api/v1/jobs/createTask',
      {
        model: 'qwen/image-to-image',
        input: {
          prompt: PROMPT,
          image_url: imageUrl,
          strength: 0.6,
          output_format: 'png',
          acceleration: 'none',
          negative_prompt: NEGATIVE,
          num_inference_steps: 30,
          guidance_scale: 2.5,
          enable_safety_checker: true,
        },
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.KIE_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      }
    );

    console.log('Resposta:', JSON.stringify(createRes.data));
    const taskId = createRes.data?.data?.taskId;
    if (!taskId) { cleanup(tempFile); return res.json({ sucesso: false, erro: 'Erro ao criar tarefa.' }); }
    console.log('Tarefa:', taskId);

    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const statusRes = await axios.get(
        `https://api.kie.ai/api/v1/jobs/recordInfo?taskId=${taskId}`,
        { headers: { Authorization: `Bearer ${process.env.KIE_API_KEY}` } }
      );
      const data  = statusRes.data?.data;
      const state = data?.state;
      console.log(`Status (${i+1}): ${state}`);

      if (state === 'success' || state === 'SUCCESS') {
        try {
          const result = JSON.parse(data.resultJson);
          const url    = result?.resultUrls?.[0];
          if (url) { cleanup(tempFile); return res.json({ sucesso: true, imageUrl: url }); }
        } catch(e) { console.log('resultJson:', data.resultJson); }
      }
      if (state === 'failed' || state === 'FAILED' || state === 'fail') {
        cleanup(tempFile);
        return res.json({ sucesso: false, erro: 'Falha: ' + (data?.failMsg || 'erro') });
      }
    }

    cleanup(tempFile);
    return res.json({ sucesso: false, erro: 'Tempo esgotado. Tente novamente.' });

  } catch (err) {
    cleanup(tempFile);
    const msg = err.response?.data?.msg || err.message;
    console.error('Erro:', msg);
    res.json({ sucesso: false, erro: msg });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Restaures rodando em http://localhost:${PORT}`));
