require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const path    = require('path');

const app = express();
app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const RESTORATION_PROMPT = `Professional AI restoration and ultra-high-definition 8K upscale of an old photograph. Enhance all textures, sharpen blurry edges, and recover lost details from the original reference. Remove all noise, film grain, scratches, and dust. Apply vibrant, natural color correction while maintaining the original composition. Crystal clear, photorealistic, and sharp focus. Restore faces with high fidelity. Make it look like a modern high quality photograph.`;

app.post('/api/restaurar', async (req, res) => {
  try {
    const { image } = req.body;
    if (!image) return res.json({ sucesso: false, erro: 'Imagem não recebida.' });

    // Envia base64 puro (sem prefixo data:)
    const base64puro = image.replace(/^data:image\/\w+;base64,/, '');

    console.log('Criando tarefa no Kie.ai...');
    const createRes = await axios.post(
      'https://api.kie.ai/api/v1/jobs/createTask',
      {
        model: 'nano-banana-2',
        input: {
          prompt: RESTORATION_PROMPT,
          image_input: [base64puro],
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

    console.log('Resposta criacao:', JSON.stringify(createRes.data));
    const taskId = createRes.data?.data?.taskId;
    if (!taskId) return res.json({ sucesso: false, erro: 'Erro ao criar tarefa.' });
    console.log('Tarefa criada:', taskId);

    // Polling
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
          const resultJson = JSON.parse(data.resultJson);
          const url = resultJson?.resultUrls?.[0];
          if (url) return res.json({ sucesso: true, imageUrl: url });
        } catch(e) {
          console.log('Erro parse resultJson:', data.resultJson);
        }
      }

      if (state === 'failed' || state === 'FAILED' || state === 'fail') {
        return res.json({ sucesso: false, erro: 'Falha no processamento: ' + (data?.failMsg || '') });
      }
    }

    return res.json({ sucesso: false, erro: 'Tempo esgotado. Tente novamente.' });

  } catch (err) {
    const msg = err.response?.data?.msg || err.response?.data?.message || err.message;
    console.error('Erro:', msg);
    res.json({ sucesso: false, erro: msg });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Restaures rodando em http://localhost:${PORT}`));
