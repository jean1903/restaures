require('dotenv').config();
const express    = require('express');
const axios      = require('axios');
const path       = require('path');
const FormData   = require('form-data');
const jwt        = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const { v4: uuidv4 } = require('uuid');
const db         = require('./db');

const app = express();
app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const JWT_SECRET = process.env.JWT_SECRET || 'restaures-secret-2025';
const BASE_URL   = process.env.BASE_URL   || 'https://restaurantes.onrender.com';

const PLANOS = {
  starter: { nome: 'Starter', creditos: 5,  preco: 'R$9,90'  },
  pro:     { nome: 'Pro',     creditos: 20, preco: 'R$24,90' },
  ultra:   { nome: 'Ultra',   creditos: 60, preco: 'R$59,90' },
};

const PROMPT = `Professional AI restoration and ultra-high-definition 8K upscale of an old photograph. Enhance all textures, sharpen blurry edges, and recover lost details from the original reference. Remove all noise, film grain, scratches, and dust. Apply vibrant, natural color correction while maintaining the original composition. Crystal clear, photorealistic, and sharp focus. Restore faces with high fidelity. Make it look like a modern high quality photograph.`;

// ── Email ──────────────────────────────────────────
const mailer = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: 587,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

async function enviarLinkLogin(email, link) {
  await mailer.sendMail({
    from: `Restaures <${process.env.SMTP_USER}>`,
    to: email,
    subject: 'Seu link de acesso — Restaures',
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:2rem;background:#111;color:#F0EDE8">
        <h2 style="color:#C9A84C;font-family:Georgia,serif">Restaures</h2>
        <p>Clique no botão abaixo para acessar sua conta:</p>
        <a href="${link}" style="display:inline-block;background:#C9A84C;color:#000;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:bold;margin:1rem 0">Acessar minha conta</a>
        <p style="color:#888;font-size:.8rem">Link válido por 15 minutos. Se não solicitou este email, ignore-o.</p>
      </div>
    `,
  });
}

// ── Auth middleware ────────────────────────────────
function auth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ erro: 'Não autenticado.' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.email = payload.email;
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
//  AUTH
// ══════════════════════════════════════════════════

app.post('/api/auth/solicitar', async (req, res) => {
  const { email } = req.body;
  if (!email || !email.includes('@')) return res.json({ erro: 'Email inválido.' });

  const existe = db.prepare('SELECT id FROM usuarios WHERE email = ?').get(email);
  if (!existe) db.prepare('INSERT INTO usuarios (id, email, creditos) VALUES (?, ?, 0)').run(uuidv4(), email);

  const token  = uuidv4();
  const expira = Date.now() + 15 * 60 * 1000;
  db.prepare('INSERT INTO tokens (token, email, expira_em) VALUES (?, ?, ?)').run(token, email, expira);

  const link = `${BASE_URL}/api/auth/verificar?token=${token}`;
  try {
    await enviarLinkLogin(email, link);
    res.json({ sucesso: true });
  } catch (e) {
    console.error('Erro email:', e.message);
    res.json({ erro: 'Erro ao enviar email.' });
  }
});

app.get('/api/auth/verificar', (req, res) => {
  const { token } = req.query;
  const reg = db.prepare('SELECT * FROM tokens WHERE token = ?').get(token);
  if (!reg || reg.usado || Date.now() > reg.expira_em) return res.redirect('/?erro=link-invalido');
  db.prepare('UPDATE tokens SET usado = 1 WHERE token = ?').run(token);
  const jwtToken = jwt.sign({ email: reg.email }, JWT_SECRET, { expiresIn: '30d' });
  res.redirect(`/?jwt=${jwtToken}`);
});

app.get('/api/usuario', auth, (req, res) => {
  const u = db.prepare('SELECT email, creditos FROM usuarios WHERE email = ?').get(req.email);
  res.json(u || { email: req.email, creditos: 0 });
});

// ══════════════════════════════════════════════════
//  ADMIN — adicionar créditos manualmente
//  POST /api/admin/creditos  { secret, email, creditos }
// ══════════════════════════════════════════════════
app.post('/api/admin/creditos', (req, res) => {
  const { secret, email, creditos } = req.body;
  if (secret !== process.env.ADMIN_SECRET) return res.status(403).json({ erro: 'Sem permissão.' });
  const u = db.prepare('SELECT id FROM usuarios WHERE email = ?').get(email);
  if (!u) return res.json({ erro: 'Usuário não encontrado.' });
  db.prepare('UPDATE usuarios SET creditos = creditos + ? WHERE email = ?').run(creditos, email);
  const atualizado = db.prepare('SELECT creditos FROM usuarios WHERE email = ?').get(email);
  res.json({ sucesso: true, creditos: atualizado.creditos });
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

    const base64  = image.replace(/^data:image\/\w+;base64,/, '');
    const imageUrl = await uploadImgBB(base64);
    console.log('URL ImgBB:', imageUrl);

    const createRes = await axios.post(
      'https://api.kie.ai/api/v1/jobs/createTask',
      { model: 'nano-banana-2', input: { prompt: PROMPT, image_input: [imageUrl], aspect_ratio: 'auto', resolution: '1K', output_format: 'png' } },
      { headers: { Authorization: `Bearer ${process.env.KIE_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 30000 }
    );

    const taskId = createRes.data?.data?.taskId;
    if (!taskId) return res.json({ sucesso: false, erro: 'Erro ao criar tarefa.' });
    console.log('Tarefa:', taskId);

    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const poll  = await axios.get(`https://api.kie.ai/api/v1/jobs/recordInfo?taskId=${taskId}`, { headers: { Authorization: `Bearer ${process.env.KIE_API_KEY}` } });
      const data  = poll.data?.data;
      const state = data?.state;
      console.log(`Status (${i+1}): ${state}`);

      if (state === 'success' || state === 'SUCCESS') {
        try {
          const result = JSON.parse(data.resultJson);
          const url    = result?.resultUrls?.[0];
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
