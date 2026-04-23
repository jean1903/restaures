require('dotenv').config();
const express  = require('express');
const axios    = require('axios');
const path     = require('path');
const FormData = require('form-data');
const jwt      = require('jsonwebtoken');
const bcrypt   = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const db       = require('./db');

const app = express();
app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const JWT_SECRET = process.env.JWT_SECRET || 'restaures-secret-2025';

const PROMPT = `Professional AI restoration and ultra-high-definition 8K upscale of an old photograph. Enhance all textures, sharpen blurry edges, and recover lost details from the original reference. Remove all noise, film grain, scratches, and dust. Apply vibrant, natural color correction while maintaining the original composition. Crystal clear, photorealistic, and sharp focus. Restore faces with high fidelity. Make it look like a modern high quality photograph.`;

// ── Auth middleware ────────────────────────────────
function auth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ erro: 'Não autenticado.' });
  try {
    req.email = jwt.verify(token, JWT_SECRET).email;
    next();
  } catch { res.status(401).json({ erro: 'Token inválido.' }); }
}

// ── ImgBB ──────────────────────────────────────────
async function uploadImgBB(base64) {
  const form = new FormData();
  form.append('image', base64);
  const res = await axios.post(
    `https://api.imgbb.com/1/upload?key=${process.env.IMGBB_API_KEY}`,
    form, { headers: form.getHeaders(), timeout: 30000 }
  );
  return res.data.data.url;
}

// ══════════════════════════════════════════════════
//  AUTH — Cadastro e Login
// ══════════════════════════════════════════════════

// Cadastro
app.post('/api/auth/cadastro', async (req, res) => {
  const { email, senha } = req.body;
  if (!email || !email.includes('@')) return res.json({ erro: 'Email inválido.' });
  if (!senha || senha.length < 6) return res.json({ erro: 'Senha deve ter no mínimo 6 caracteres.' });

  const existe = db.prepare('SELECT id FROM usuarios WHERE email = ?').get(email);
  if (existe) return res.json({ erro: 'Email já cadastrado.' });

  const hash = await bcrypt.hash(senha, 10);
  db.prepare('INSERT INTO usuarios (id, email, senha, creditos) VALUES (?, ?, ?, 2)').run(uuidv4(), email, hash);

  const token = jwt.sign({ email }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ sucesso: true, token });
});

// Login
app.post('/api/auth/login', async (req, res) => {
  const { email, senha } = req.body;
  if (!email || !senha) return res.json({ erro: 'Preencha email e senha.' });

  const usuario = db.prepare('SELECT * FROM usuarios WHERE email = ?').get(email);
  if (!usuario) return res.json({ erro: 'Email não encontrado.' });

  const ok = await bcrypt.compare(senha, usuario.senha);
  if (!ok) return res.json({ erro: 'Senha incorreta.' });

  const token = jwt.sign({ email }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ sucesso: true, token, creditos: usuario.creditos });
});

// Dados do usuário
app.get('/api/usuario', auth, (req, res) => {
  const u = db.prepare('SELECT email, creditos FROM usuarios WHERE email = ?').get(req.email);
  res.json(u || { email: req.email, creditos: 0 });
});

// ══════════════════════════════════════════════════
//  ADMIN — adicionar créditos
// ══════════════════════════════════════════════════
app.post('/api/admin/creditos', (req, res) => {
  const { secret, email, creditos } = req.body;
  if (secret !== process.env.ADMIN_SECRET) return res.status(403).json({ erro: 'Sem permissão.' });
  const u = db.prepare('SELECT id FROM usuarios WHERE email = ?').get(email);
  if (!u) return res.json({ erro: 'Usuário não encontrado.' });
  db.prepare('UPDATE usuarios SET creditos = creditos + ? WHERE email = ?').run(creditos, email);
  const novo = db.prepare('SELECT creditos FROM usuarios WHERE email = ?').get(email);
  res.json({ sucesso: true, creditos: novo.creditos });
});

// ══════════════════════════════════════════════════
//  RESTAURAÇÃO
// ══════════════════════════════════════════════════
app.post('/api/restaurar', auth, async (req, res) => {
  const u = db.prepare('SELECT creditos FROM usuarios WHERE email = ?').get(req.email);
  if (!u || u.creditos < 1) return res.json({ sucesso: false, semCreditos: true, erro: 'Sem créditos.' });

  try {
    const { image } = req.body;
    if (!image) return res.json({ sucesso: false, erro: 'Imagem não recebida.' });

    const base64   = image.replace(/^data:image\/\w+;base64,/, '');
    const imageUrl = await uploadImgBB(base64);
    console.log('ImgBB:', imageUrl);

    const createRes = await axios.post(
      'https://api.kie.ai/api/v1/jobs/createTask',
      { model: 'nano-banana-2', input: { prompt: PROMPT, image_input: [imageUrl], aspect_ratio: 'auto', resolution: '1K', output_format: 'png' } },
      { headers: { Authorization: `Bearer ${process.env.KIE_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 30000 }
    );

    const taskId = createRes.data?.data?.taskId;
    if (!taskId) return res.json({ sucesso: false, erro: 'Erro ao criar tarefa.' });

    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const poll  = await axios.get(`https://api.kie.ai/api/v1/jobs/recordInfo?taskId=${taskId}`, { headers: { Authorization: `Bearer ${process.env.KIE_API_KEY}` } });
      const data  = poll.data?.data;
      const state = data?.state;
      console.log(`Status (${i+1}): ${state}`);

      if (state === 'success' || state === 'SUCCESS') {
        try {
          const url = JSON.parse(data.resultJson)?.resultUrls?.[0];
          if (url) {
            db.prepare('UPDATE usuarios SET creditos = creditos - 1 WHERE email = ?').run(req.email);
            const novo = db.prepare('SELECT creditos FROM usuarios WHERE email = ?').get(req.email);
            return res.json({ sucesso: true, imageUrl: url, creditos: novo.creditos });
          }
        } catch(e) { console.log('resultJson:', data.resultJson); }
      }
      if (state === 'failed' || state === 'FAILED' || state === 'fail') return res.json({ sucesso: false, erro: 'Falha no processamento.' });
    }
    return res.json({ sucesso: false, erro: 'Tempo esgotado. Tente novamente.' });

  } catch (err) {
    console.error('Erro:', err.message);
    res.json({ sucesso: false, erro: err.message });
  }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Restaures v2 rodando em http://localhost:${PORT}`));
