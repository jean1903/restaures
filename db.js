const fs   = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, 'restaures_data.json');

function load() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ usuarios: {} }, null, 2));
  }
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}

function save(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

module.exports = {
  getUsuario(email) {
    return load().usuarios[email] || null;
  },

  criarUsuario(id, email, senha) {
    const data = load();
    data.usuarios[email] = { id, email, senha, creditos: 2, criado_em: new Date().toISOString() };
    save(data);
  },

  atualizarSenha(email, senha) {
    const data = load();
    if (data.usuarios[email]) { data.usuarios[email].senha = senha; save(data); }
  },

  descontarCredito(email) {
    const data = load();
    if (data.usuarios[email]) { data.usuarios[email].creditos -= 1; save(data); }
    return data.usuarios[email]?.creditos ?? 0;
  },

  adicionarCreditos(email, quantidade) {
    const data = load();
    if (!data.usuarios[email]) return false;
    data.usuarios[email].creditos += quantidade;
    save(data);
    return data.usuarios[email].creditos;
  },
};
