require('dotenv').config();
const express  = require('express');
const axios    = require('axios');
const path     = require('path');
const FormData = require('form-data');

const app = express();
app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PROMPT = `Professional AI restoration and ultra-high-definition 8K upscale of an old photograph. Enhance all textures, sharpen blurry edges, and recover lost details from the original reference. Remove all noise, film grain, scratches, and dust. Apply vibrant, natural color correction while maintaining the original composition. Crystal clear, photorealistic, and sharp focus. Restore faces with high fidelity. Make it look like a modern high quality photograph.`;

async function uploadImgBB(base64) {
  const form = new FormData();
  form.append('image', base64);
  const res = await axios.post(
    `https://api.imgbb.com/1/upload?key=${process.env.IMGBB_API_KEY}`,
    form,
    { headers: form.getHeaders(), timeout: 30000 }
  );
  return res.data.data.url;
}

app.post('/api/restaurar', async (req, res) => {
  try {
    const { image } = req.body;
    if (!image) return res.json({ sucesso: false, erro: 'Imagem nao recebida.' });

    const base64 = image.replace(/^data:image\/\w+;base64,/, '');

    // 1. Upload ImgBB
    console.log('Fazendo upload no ImgBB...');
    const imageUrl = await uploadImgBB(base64);
    console.log('URL publica:', imageUrl);

    // 2. Envia para Nano Banana 2 com imagem + prompt
    console.log('Enviando para Nano Banana 2...');
    const createRes = await axios.post(
      'https://api.kie.ai/api/v1/jobs/createTask',
      {
        model: 'nano-banana-2',
        input: {
          prompt: PROMPT,
          image_input: [imageUrl],
          aspect_ratio: 'auto',
          resolution: '1K',
          output_format: 'png',
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
    if (!taskId) return res.json({ sucesso: false, erro: 'Erro ao criar tarefa: ' + JSON.stringify(createRes.data) });
    console.log('Tarefa criada:', taskId);

    // 3. Polling
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
          if (url) return res.json({ sucesso: true, imageUrl: url });
        } catch(e) { console.log('resultJson:', data.resultJson); }
      }

      if (state === 'failed' || state === 'FAILED' || state === 'fail') {
        return res.json({ sucesso: false, erro: 'Falha: ' + (data?.failMsg || 'erro') });
      }
    }

    return res.json({ sucesso: false, erro: 'Tempo esgotado. Tente novamente.' });

  } catch (err) {
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
