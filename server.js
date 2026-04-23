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

const JWT_SECRET   = process.env.JWT_SECRET   || 'restaures-secret-2025';
const ADMIN_SECRET = process.env.ADMIN_SECRET  || 'admin123';
const MP_TOKEN     = process.env.MP_ACCESS_TOKEN;

const PLANOS = {
  teste:     { nome: 'Plano Teste',     creditos: 1,  preco: 2.90  },
  basico:    { nome: 'Plano Básico',    creditos: 5,  preco: 9.90  },
  economico: { nome: 'Plano Econômico', creditos: 10, preco: 17.90 },
  familia:   { nome: 'Plano Família',   creditos: 20, preco: 29.90 },
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
//  MERCADO PAGO — criar pagamento PIX
// ══════════════════════════════════════════════════
app.post('/api/pagamento/criar', auth, async (req, res) => {
  const { plano } = req.body;
  const p = PLANOS[plano];
  if (!p) return res.json({ erro: 'Plano inválido.' });

  try {
    const response = await axios.post(
      'https://api.mercadopago.com/v1/payments',
      {
        transaction_amount: p.preco,
        description: p.nome,
        payment_method_id: 'pix',
        payer: { email: req.email },
        metadata: { email: req.email, plano, creditos: p.creditos },
        notification_url: `${process.env.BASE_URL}/api/pagamento/webhook`,
      },
      {
        headers: {
          Authorization: `Bearer ${MP_TOKEN}`,
          'Content-Type': 'application/json',
          'X-Idempotency-Key': uuidv4(),
        },
      }
    );

    const pix = response.data.point_of_interaction?.transaction_data;
    res.json({
      sucesso: true,
      pixCopiaECola: pix?.qr_code,
      qrCodeBase64: pix?.qr_code_base64,
      paymentId: response.data.id,
      valor: p.preco,
      plano: p.nome,
      creditos: p.creditos,
    });

  } catch (err) {
    console.error('Erro MP:', err.response?.data || err.message);
    res.json({ erro: 'Erro ao gerar PIX.' });
  }
});

// Verificar status do pagamento
app.get('/api/pagamento/status/:id', auth, async (req, res) => {
  try {
    const response = await axios.get(
      `https://api.mercadopago.com/v1/payments/${req.params.id}`,
      { headers: { Authorization: `Bearer ${MP_TOKEN}` } }
    );
    const status = response.data.status;
    if (status === 'approved') {
      const { email, plano, creditos } = response.data.metadata;
      const userEmail = email || req.email;
      const u = db.getUsuario(userEmail);
      if (u) {
        const novo = db.adicionarCreditos(userEmail, parseInt(creditos));
        return res.json({ sucesso: true, status, creditos: novo });
      }
    }
    res.json({ sucesso: false, status });
  } catch (err) {
    res.json({ erro: err.message });
  }
});

// Webhook Mercado Pago
app.post('/api/pagamento/webhook', async (req, res) => {
  try {
    const { type, data } = req.body;
    console.log('Webhook MP:', type, data?.id);

    if (type === 'payment' && data?.id) {
      const response = await axios.get(
        `https://api.mercadopago.com/v1/payments/${data.id}`,
        { headers: { Authorization: `Bearer ${MP_TOKEN}` } }
      );
      const payment = response.data;
      console.log('Payment status:', payment.status, '| email:', payment.payer?.email);

      if (payment.status === 'approved') {
        const email   = payment.metadata?.email || payment.payer?.email;
        const creditos = parseInt(payment.metadata?.creditos || 0);
        if (email && creditos > 0) {
          const u = db.getUsuario(email);
          if (!u) {
            const hash = await bcrypt.hash(Math.random().toString(36), 10);
            db.criarUsuario(uuidv4(), email, hash);
          }
          const novo = db.adicionarCreditos(email, creditos);
          console.log(`+${creditos} créditos para ${email} | Total: ${novo}`);
        }
      }
    }
    res.sendStatus(200);
  } catch (err) {
    console.error('Erro webhook MP:', err.message);
    res.sendStatus(200);
  }
});

// ══════════════════════════════════════════════════
//  ADMIN
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
        } catch(e) {}
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
