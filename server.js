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

const JWT_SECRET     = process.env.JWT_SECRET     || 'restaures-secret-2025';
const WIAPY_TOKEN    = process.env.WIAPY_TOKEN     || '';
const ADMIN_SECRET   = process.env.ADMIN_SECRET    || 'admin123';

// Mapa de produtos Wiapy → créditos
// Coloque aqui os IDs dos produtos que você criar na Wiapy
const PRODUTOS_CREDITOS = {
  'teste':     1,
  'basico':    5,
  'economico': 10,
  'familia':   20,
};

// Também mapeia por título do produto
const TITULO_CREDITOS = {
  'plano teste':      1,
  'plano básico':     5,
  'plano econômico':  10,
  'plano família':    20,
  'restaures teste':  1,
  'restaures básico': 5,
  'restaures econômico': 10,
  'restaures família': 20,
};

const PROMPT = `Professional AI restoration and ultra-high-definition 8K upscale of an old photograph. Enhance all textures, sharpen blurry edges, and recover lost details from the original reference. Remove all noise, film grain, scratches, and dust. Apply vibrant, natural color correction while maintaining the original composition. Crystal clear, photorealistic, and sharp focus. Restore faces with high fidelity. Make it look like a modern high quality photograph.`;

function auth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ erro: 'Não autenticado.' });
  try { req.email = jwt.verify(token, JWT_SECRET).email; next(); }
  catch { res.status(401).json({ erro: 'Token inválido.' }); }
}

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
app.post('/api/auth/cadastro', async (req, res) => {
  const { email, senha } = req.body;
  if (!email || !email.includes('@')) return res.json({ erro: 'Email inválido.' });
  if (!senha || senha.length < 6) return res.json({ erro: 'Senha deve ter mínimo 6 caracteres.' });
  if (db.getUsuario(email)) return res.json({ erro: 'Email já cadastrado.' });

  const hash = await bcrypt.hash(senha, 10);
  db.criarUsuario(uuidv4(), email, hash);

  const token = jwt.sign({ email }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ sucesso: true, token, creditos: 0 });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, senha } = req.body;
  if (!email || !senha) return res.json({ erro: 'Preencha email e senha.' });

  const usuario = db.getUsuario(email);
  if (!usuario) return res.json({ erro: 'Email não encontrado.' });

  const ok = await bcrypt.compare(senha, usuario.senha);
  if (!ok) return res.json({ erro: 'Senha incorreta.' });

  const token = jwt.sign({ email }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ sucesso: true, token, creditos: usuario.creditos });
});

app.get('/api/usuario', auth, (req, res) => {
  const u = db.getUsuario(req.email);
  res.json(u ? { email: u.email, creditos: u.creditos } : { email: req.email, creditos: 0 });
});

// ══════════════════════════════════════════════════
//  WEBHOOK WIAPY — libera créditos automaticamente
// ══════════════════════════════════════════════════
app.post('/api/webhook/wiapy', async (req, res) => {
  try {
    // Valida token de autenticação da Wiapy
    const authHeader = req.headers['authorization'];
    if (WIAPY_TOKEN && authHeader !== WIAPY_TOKEN) {
      console.log('Webhook Wiapy: token inválido');
      return res.status(401).json({ ok: false });
    }

    const { payment, customer, checkout, products } = req.body;
    console.log('Webhook Wiapy recebido:', JSON.stringify({ payment, customer, checkout }));

    // Só processa pagamentos aprovados
    if (!payment || payment.status !== 'paid') {
      return res.json({ ok: true, msg: 'Ignorado: não é pagamento aprovado' });
    }

    const email = customer?.email;
    if (!email) return res.json({ ok: false, msg: 'Email não encontrado' });

    // Descobre quantos créditos liberar pelo título do produto
    let creditos = 0;
    if (products && products.length > 0) {
      for (const prod of products) {
        const titulo = (prod.title || '').toLowerCase();
        for (const [key, val] of Object.entries(TITULO_CREDITOS)) {
          if (titulo.includes(key)) { creditos = val; break; }
        }
        if (creditos > 0) break;
      }
    }

    // Fallback: pelo valor pago
    if (creditos === 0 && payment.amount) {
      const valor = payment.amount; // em centavos
      if (valor <= 300)       creditos = 1;   // R$2,90
      else if (valor <= 1000) creditos = 5;   // R$9,90
      else if (valor <= 1800) creditos = 10;  // R$17,90
      else                    creditos = 20;  // R$29,90
    }

    if (creditos === 0) {
      console.log('Webhook Wiapy: não foi possível determinar créditos');
      return res.json({ ok: true, msg: 'Créditos não determinados' });
    }

    // Cria usuário se não existir
    const usuario = db.getUsuario(email);
    if (!usuario) {
      const hash = await bcrypt.hash(Math.random().toString(36), 10);
      db.criarUsuario(uuidv4(), email, hash);
    }

    // Adiciona créditos
    const novos = db.adicionarCreditos(email, creditos);
    console.log(`Wiapy: +${creditos} créditos para ${email} | Total: ${novos}`);

    res.json({ ok: true, email, creditos, total: novos });

  } catch (err) {
    console.error('Erro webhook Wiapy:', err.message);
    res.status(500).json({ ok: false });
  }
});

// ══════════════════════════════════════════════════
//  ADMIN — adicionar créditos manualmente
// ══════════════════════════════════════════════════
app.post('/api/admin/creditos', (req, res) => {
  const { secret, email, creditos } = req.body;
  if (secret !== ADMIN_SECRET) return res.status(403).json({ erro: 'Sem permissão.' });
  const u = db.getUsuario(email);
  if (!u) return res.json({ erro: 'Usuário não encontrado.' });
  const novo = db.adicionarCreditos(email, creditos);
  res.json({ sucesso: true, creditos: novo });
});

// ══════════════════════════════════════════════════
//  RESTAURAÇÃO
// ══════════════════════════════════════════════════
app.post('/api/restaurar', auth, async (req, res) => {
  const u = db.getUsuario(req.email);
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
            const novos = db.descontarCredito(req.email);
            return res.json({ sucesso: true, imageUrl: url, creditos: novos });
          }
        } catch(e) { console.log('resultJson:', data.resultJson); }
      }
      if (state === 'failed' || state === 'FAILED' || state === 'fail') return res.json({ sucesso: false, erro: 'Falha no processamento.' });
    }
    return res.json({ sucesso: false, erro: 'Tempo esgotado. Tente novamente.' });

  } catch (err) {
    console.error('Erro restaurar:', err.message);
    res.json({ sucesso: false, erro: err.message });
  }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Restaures v2 rodando em http://localhost:${PORT}`));
