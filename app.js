const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const initSqlJs = require('sql.js');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const XLSX = require('xlsx');
const iconv = require('iconv-lite');

const app = express();
const PORT = process.env.PORT || 3000;

// 日本時間を取得する関数
function getJSTDatetime() {
  const now = new Date();
  const jst = new Date(now.getTime() + (9 * 60 * 60 * 1000));
  return jst.toISOString().slice(0, 19).replace('T', ' ');
}

// CSVファイルの文字コードを自動判定して読み込む
function readCSVFile(filePath) {
  const buffer = fs.readFileSync(filePath);
  
  // BOMチェック（UTF-8）
  if (buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) {
    return buffer.toString('utf-8');
  }
  
  // Shift-JISの特徴的なバイトパターンをチェック
  let isShiftJIS = false;
  for (let i = 0; i < Math.min(buffer.length, 1000); i++) {
    const byte = buffer[i];
    // Shift-JISの2バイト文字の1バイト目
    if ((byte >= 0x81 && byte <= 0x9F) || (byte >= 0xE0 && byte <= 0xFC)) {
      isShiftJIS = true;
      break;
    }
  }
  
  if (isShiftJIS) {
    return iconv.decode(buffer, 'Shift_JIS');
  }
  
  return buffer.toString('utf-8');
}

// 文字列正規化関数（半角カタカナ→全角カタカナ、全角英数→半角など）
function normalizeString(str) {
  if (!str) return '';
  return String(str)
    .trim()
    // 半角カタカナを全角カタカナに変換
    .replace(/[\uff66-\uff9f]/g, (s) => {
      const kanaMap = {
        'ｦ': 'ヲ', 'ｧ': 'ァ', 'ｨ': 'ィ', 'ｩ': 'ゥ', 'ｪ': 'ェ', 'ｫ': 'ォ', 'ｬ': 'ャ', 'ｭ': 'ュ', 'ｮ': 'ョ', 'ｯ': 'ッ',
        'ｰ': 'ー', 'ｱ': 'ア', 'ｲ': 'イ', 'ｳ': 'ウ', 'ｴ': 'エ', 'ｵ': 'オ', 'ｶ': 'カ', 'ｷ': 'キ', 'ｸ': 'ク', 'ｹ': 'ケ', 'ｺ': 'コ',
        'ｻ': 'サ', 'ｼ': 'シ', 'ｽ': 'ス', 'ｾ': 'セ', 'ｿ': 'ソ', 'ﾀ': 'タ', 'ﾁ': 'チ', 'ﾂ': 'ツ', 'ﾃ': 'テ', 'ﾄ': 'ト',
        'ﾅ': 'ナ', 'ﾆ': 'ニ', 'ﾇ': 'ヌ', 'ﾈ': 'ネ', 'ﾉ': 'ノ', 'ﾊ': 'ハ', 'ﾋ': 'ヒ', 'ﾌ': 'フ', 'ﾍ': 'ヘ', 'ﾎ': 'ホ',
        'ﾏ': 'マ', 'ﾐ': 'ミ', 'ﾑ': 'ム', 'ﾒ': 'メ', 'ﾓ': 'モ', 'ﾔ': 'ヤ', 'ﾕ': 'ユ', 'ﾖ': 'ヨ',
        'ﾗ': 'ラ', 'ﾘ': 'リ', 'ﾙ': 'ル', 'ﾚ': 'レ', 'ﾛ': 'ロ', 'ﾜ': 'ワ', 'ﾝ': 'ン', 'ﾞ': '゛', 'ﾟ': '゜'
      };
      return kanaMap[s] || s;
    })
    // 全角英数を半角に
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (s) => String.fromCharCode(s.charCodeAt(0) - 0xFEE0))
    // 株式会社の表記揺れを統一
    .replace(/㈱/g, '株式会社')
    .replace(/\(株\)/g, '株式会社')
    .replace(/（株）/g, '株式会社')
    // スペースを削除
    .replace(/[\s　]+/g, '');
}

// アップロードフォルダ作成
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// multer設定
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, uniqueSuffix + ext);
  }
});
const upload = multer({ 
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB制限
});

// グローバル変数でデータベースを保持
let db = null;

// データベースを定期的に保存する関数
function saveDatabase() {
  if (db) {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(path.join(__dirname, 'db', 'database.sqlite'), buffer);
  }
}

// 5分ごとにデータベースを保存
setInterval(saveDatabase, 5 * 60 * 1000);

// ミドルウェア設定
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/docs', express.static(path.join(__dirname, 'docs')));

// セッション設定
app.use(session({
  secret: 'daily-report-secret-key-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: false,
    maxAge: 24 * 60 * 60 * 1000
  }
}));

// テンプレートエンジン設定
app.set('views', path.join(__dirname, 'views'));

// データベースをリクエストで使えるようにする
app.use((req, res, next) => {
  req.db = db;
  next();
});

// 認証チェックミドルウェア
const requireAuth = (req, res, next) => {
  if (!req.session.user) {
    return res.redirect('/login.html');
  }
  next();
};

// 管理者チェックミドルウェア
const requireAdmin = (req, res, next) => {
  if (!req.session.user || req.session.user.role !== 'admin') {
    return res.status(403).json({ error: '管理者権限が必要です' });
  }
  next();
};

// ============================================
// 認証関連API
// ============================================

// ログイン
app.post('/api/login', (req, res) => {
  const { login_id, password } = req.body;
  
  const stmt = db.prepare(`
    SELECT u.*, d.name as department_name 
    FROM users u 
    LEFT JOIN departments d ON u.department_id = d.id 
    WHERE u.login_id = ?
  `);
  stmt.bind([login_id]);
  
  let user = null;
  if (stmt.step()) {
    const row = stmt.getAsObject();
    user = row;
  }
  stmt.free();
  
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'IDまたはパスワードが正しくありません' });
  }
  
  req.session.user = {
    id: user.id,
    login_id: user.login_id,
    name: user.name,
    email: user.email,
    department_id: user.department_id,
    department_name: user.department_name,
    role: user.role
  };
  
  res.json({ success: true, user: req.session.user });
});

// ログアウト
app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// 現在のユーザー情報取得
app.get('/api/me', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: '未ログイン' });
  }
  res.json(req.session.user);
});

// ============================================
// マスタデータAPI
// ============================================

// 部署一覧
app.get('/api/departments', requireAuth, (req, res) => {
  const results = [];
  const stmt = db.prepare('SELECT * FROM departments ORDER BY name');
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  res.json(results);
});

// メーカー一覧
app.get('/api/manufacturers', requireAuth, (req, res) => {
  const results = [];
  const stmt = db.prepare('SELECT * FROM manufacturers ORDER BY name');
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  res.json(results);
});

// 期限切れ・期限間近タスク取得
app.get('/api/tasks/alerts', requireAuth, (req, res) => {
  const userId = req.session.user.id;
  const today = new Date().toISOString().split('T')[0];
  
  try {
    // 期限切れタスク（未完了）
    const overdueStmt = db.prepare(`
      SELECT t.*, dr.report_date, dr.user_id
      FROM tasks t
      JOIN daily_reports dr ON t.report_id = dr.id
      WHERE dr.user_id = ? AND t.is_completed = 0 AND t.due_date < ? AND t.due_date IS NOT NULL
      ORDER BY t.due_date ASC
    `);
    overdueStmt.bind([userId, today]);
    const overdue = [];
    while (overdueStmt.step()) {
      overdue.push(overdueStmt.getAsObject());
    }
    overdueStmt.free();

    // 今日が期限のタスク（未完了）
    const todayStmt = db.prepare(`
      SELECT t.*, dr.report_date, dr.user_id
      FROM tasks t
      JOIN daily_reports dr ON t.report_id = dr.id
      WHERE dr.user_id = ? AND t.is_completed = 0 AND t.due_date = ?
      ORDER BY t.due_date ASC
    `);
    todayStmt.bind([userId, today]);
    const dueToday = [];
    while (todayStmt.step()) {
      dueToday.push(todayStmt.getAsObject());
    }
    todayStmt.free();

    // 明日〜3日以内が期限のタスク（未完了）
    const threeDaysLater = new Date();
    threeDaysLater.setDate(threeDaysLater.getDate() + 3);
    const threeDaysStr = threeDaysLater.toISOString().split('T')[0];
    
    const upcomingStmt = db.prepare(`
      SELECT t.*, dr.report_date, dr.user_id
      FROM tasks t
      JOIN daily_reports dr ON t.report_id = dr.id
      WHERE dr.user_id = ? AND t.is_completed = 0 AND t.due_date > ? AND t.due_date <= ?
      ORDER BY t.due_date ASC
    `);
    upcomingStmt.bind([userId, today, threeDaysStr]);
    const upcoming = [];
    while (upcomingStmt.step()) {
      upcoming.push(upcomingStmt.getAsObject());
    }
    upcomingStmt.free();

    res.json({
      overdue,
      dueToday,
      upcoming,
      total: overdue.length + dueToday.length + upcoming.length
    });
  } catch (error) {
    console.error('タスクアラートエラー:', error);
    res.status(500).json({ error: error.message });
  }
});

// タスク完了
app.post('/api/tasks/:id/complete', requireAuth, (req, res) => {
  try {
    const taskId = req.params.id;
    const userId = req.session.user.id;
    
    // タスクの所有者確認
    const stmt = db.prepare('SELECT * FROM tasks WHERE id = ?');
    stmt.bind([taskId]);
    if (!stmt.step()) {
      stmt.free();
      return res.status(404).json({ error: 'タスクが見つかりません' });
    }
    const task = stmt.getAsObject();
    stmt.free();
    
    // 自分のタスクかチェック（日報のuser_idを確認）
    const reportStmt = db.prepare('SELECT user_id FROM daily_reports WHERE id = ?');
    reportStmt.bind([task.report_id]);
    if (reportStmt.step()) {
      const report = reportStmt.getAsObject();
      if (report.user_id !== userId) {
        reportStmt.free();
        return res.status(403).json({ error: '他のユーザーのタスクは完了できません' });
      }
    }
    reportStmt.free();
    
    // タスクを完了にする
    db.run('UPDATE tasks SET is_completed = 1 WHERE id = ?', [taskId]);
    saveDatabase();
    
    res.json({ success: true });
  } catch (error) {
    console.error('タスク完了エラー:', error);
    res.status(500).json({ error: error.message });
  }
});

// 顧客一覧（担当営業情報付き）
app.get('/api/customers', requireAuth, (req, res) => {
  const { q, limit } = req.query;
  let query = `
    SELECT c.*, u.name as assigned_user_name 
    FROM customers c
    LEFT JOIN users u ON c.assigned_user_id = u.id
  `;
  let params = [];
  
  if (q) {
    query += ' WHERE c.name LIKE ? OR c.customer_code LIKE ?';
    params = [`%${q}%`, `%${q}%`];
  }
  query += ' ORDER BY c.customer_code';
  
  // limitが指定された場合のみ制限
  if (limit && parseInt(limit) > 0) {
    query += ` LIMIT ${parseInt(limit)}`;
  }
  
  const results = [];
  const stmt = db.prepare(query);
  if (params.length > 0) {
    stmt.bind(params);
  }
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  res.json(results);
});

// お気に入り顧客一覧
app.get('/api/favorites', requireAuth, (req, res) => {
  const userId = req.session.user.id;
  
  const results = [];
  const stmt = db.prepare(`
    SELECT f.id, f.target_type, f.customer_id, f.supplier_id, f.sort_order,
           c.name as customer_name, c.customer_code,
           s.name as supplier_name, s.supplier_code
    FROM favorite_customers f
    LEFT JOIN customers c ON f.customer_id = c.id
    LEFT JOIN suppliers s ON f.supplier_id = s.id
    WHERE f.user_id = ?
    ORDER BY f.sort_order, f.created_at DESC
  `);
  stmt.bind([userId]);
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  res.json(results);
});

// お気に入り追加
app.post('/api/favorites', requireAuth, (req, res) => {
  const userId = req.session.user.id;
  const { target_type, customer_id, supplier_id } = req.body;
  
  try {
    if (target_type === 'customer') {
      db.run('INSERT OR IGNORE INTO favorite_customers (user_id, target_type, customer_id) VALUES (?, ?, ?)',
        [userId, 'customer', customer_id]);
    } else {
      db.run('INSERT OR IGNORE INTO favorite_customers (user_id, target_type, supplier_id) VALUES (?, ?, ?)',
        [userId, 'supplier', supplier_id]);
    }
    saveDatabase();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// お気に入り削除
app.delete('/api/favorites/:id', requireAuth, (req, res) => {
  const userId = req.session.user.id;
  const favId = parseInt(req.params.id);
  
  try {
    db.run('DELETE FROM favorite_customers WHERE id = ? AND user_id = ?', [favId, userId]);
    saveDatabase();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 顧客の担当営業を更新
app.put('/api/customers/:id/assign', requireAuth, (req, res) => {
  const customerId = parseInt(req.params.id);
  const { assigned_user_id } = req.body;
  
  try {
    db.run('UPDATE customers SET assigned_user_id = ? WHERE id = ?', [assigned_user_id || null, customerId]);
    saveDatabase();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 前回訪問内容を取得（顧客/仕入先）
app.get('/api/last-visit', requireAuth, (req, res) => {
  const userId = req.session.user.id;
  const { target_type, customer_id, supplier_id } = req.query;
  
  try {
    let query = `
      SELECT cv.*, dr.report_date, dr.user_id
      FROM customer_visits cv
      JOIN daily_reports dr ON cv.report_id = dr.id
      WHERE dr.user_id = ? AND cv.visit_type = ?
    `;
    const params = [userId, target_type];
    
    if (target_type === 'customer' && customer_id) {
      query += ' AND cv.customer_id = ?';
      params.push(customer_id);
    } else if (target_type === 'supplier' && supplier_id) {
      query += ' AND cv.supplier_id = ?';
      params.push(supplier_id);
    } else {
      return res.json(null);
    }
    
    query += ' ORDER BY dr.report_date DESC LIMIT 1';
    
    const stmt = db.prepare(query);
    stmt.bind(params);
    
    let result = null;
    if (stmt.step()) {
      result = stmt.getAsObject();
    }
    stmt.free();
    
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ユーザー一覧（チーム日報用 - 全ユーザーアクセス可能）
app.get('/api/users', requireAuth, (req, res) => {
  const results = [];
  const stmt = db.prepare(`
    SELECT u.id, u.name, u.login_id, d.name as department_name 
    FROM users u 
    LEFT JOIN departments d ON u.department_id = d.id 
    ORDER BY u.name
  `);
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  res.json(results);
});

// 全ユーザー一覧（同行者選択用）
app.get('/api/users/all', requireAuth, (req, res) => {
  const results = [];
  const stmt = db.prepare(`
    SELECT u.id, u.name, u.login_id, d.name as department_name 
    FROM users u 
    LEFT JOIN departments d ON u.department_id = d.id 
    WHERE u.role IN ('sales', 'manager')
    ORDER BY d.name, u.name
  `);
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  res.json(results);
});

// 訪問件数統計（同行含む）
app.get('/api/stats/visits', requireAuth, (req, res) => {
  const { from, to, user_id } = req.query;
  const targetUserId = user_id ? parseInt(user_id) : req.session.user.id;

  let dateFilter = '';
  const params = [];
  
  if (from) {
    dateFilter += ' AND dr.report_date >= ?';
    params.push(from);
  }
  if (to) {
    dateFilter += ' AND dr.report_date <= ?';
    params.push(to);
  }

  // 自分が担当者としての訪問件数
  const ownQuery = `
    SELECT COUNT(*) as count FROM customer_visits cv
    JOIN daily_reports dr ON cv.report_id = dr.id
    WHERE dr.user_id = ? AND dr.status != 'draft' ${dateFilter}
  `;
  const ownStmt = db.prepare(ownQuery);
  ownStmt.bind([targetUserId, ...params]);
  ownStmt.step();
  const ownCount = ownStmt.getAsObject().count;
  ownStmt.free();

  // 同行者としての訪問件数
  const companionQuery = `
    SELECT COUNT(*) as count FROM visit_companions vc
    JOIN customer_visits cv ON vc.visit_id = cv.id
    JOIN daily_reports dr ON cv.report_id = dr.id
    WHERE vc.user_id = ? AND dr.status != 'draft' ${dateFilter}
  `;
  const compStmt = db.prepare(companionQuery);
  compStmt.bind([targetUserId, ...params]);
  compStmt.step();
  const companionCount = compStmt.getAsObject().count;
  compStmt.free();

  res.json({
    own_visits: ownCount,
    companion_visits: companionCount,
    total_visits: ownCount + companionCount
  });
});

// チーム訪問統計（全ユーザーアクセス可能）
app.get('/api/stats/team-visits', requireAuth, (req, res) => {

  const { from, to } = req.query;

  let dateFilter = '';
  const params = [];
  
  if (from) {
    dateFilter += ' AND dr.report_date >= ?';
    params.push(from);
  }
  if (to) {
    dateFilter += ' AND dr.report_date <= ?';
    params.push(to);
  }

  // 全ユーザーの訪問統計
  const results = [];
  
  // ユーザー一覧取得
  const usersStmt = db.prepare(`
    SELECT u.id, u.name, d.name as department_name 
    FROM users u 
    LEFT JOIN departments d ON u.department_id = d.id 
    WHERE u.role IN ('sales', 'manager')
    ORDER BY d.name, u.name
  `);
  const users = [];
  while (usersStmt.step()) {
    users.push(usersStmt.getAsObject());
  }
  usersStmt.free();

  for (const user of users) {
    // 担当者としての訪問
    const ownQuery = `
      SELECT COUNT(*) as count FROM customer_visits cv
      JOIN daily_reports dr ON cv.report_id = dr.id
      WHERE dr.user_id = ? AND dr.status != 'draft' ${dateFilter}
    `;
    const ownStmt = db.prepare(ownQuery);
    ownStmt.bind([user.id, ...params]);
    ownStmt.step();
    const ownCount = ownStmt.getAsObject().count;
    ownStmt.free();

    // 同行者としての訪問
    const compQuery = `
      SELECT COUNT(*) as count FROM visit_companions vc
      JOIN customer_visits cv ON vc.visit_id = cv.id
      JOIN daily_reports dr ON cv.report_id = dr.id
      WHERE vc.user_id = ? AND dr.status != 'draft' ${dateFilter}
    `;
    const compStmt = db.prepare(compQuery);
    compStmt.bind([user.id, ...params]);
    compStmt.step();
    const compCount = compStmt.getAsObject().count;
    compStmt.free();

    results.push({
      user_id: user.id,
      user_name: user.name,
      department_name: user.department_name,
      own_visits: ownCount,
      companion_visits: compCount,
      total_visits: ownCount + compCount
    });
  }

  res.json(results);
});

// 訪問先別統計（全ユーザーアクセス可能）
app.get('/api/stats/visit-targets', requireAuth, (req, res) => {

  const { from, to } = req.query;

  let dateFilter = '';
  const params = [];
  
  if (from) {
    dateFilter += ' AND dr.report_date >= ?';
    params.push(from);
  }
  if (to) {
    dateFilter += ' AND dr.report_date <= ?';
    params.push(to);
  }

  // 得意先別訪問件数
  const customerQuery = `
    SELECT c.id, c.customer_code, c.name, COUNT(*) as visit_count
    FROM customer_visits cv
    JOIN customers c ON cv.customer_id = c.id
    JOIN daily_reports dr ON cv.report_id = dr.id
    WHERE cv.visit_type = 'customer' AND dr.status != 'draft' ${dateFilter}
    GROUP BY c.id
    ORDER BY visit_count DESC
    LIMIT 20
  `;
  const customerStmt = db.prepare(customerQuery);
  if (params.length > 0) customerStmt.bind(params);
  const customers = [];
  while (customerStmt.step()) {
    customers.push(customerStmt.getAsObject());
  }
  customerStmt.free();

  // 仕入先別訪問件数
  const supplierQuery = `
    SELECT s.id, s.supplier_code, s.name, COUNT(*) as visit_count
    FROM customer_visits cv
    JOIN suppliers s ON cv.supplier_id = s.id
    JOIN daily_reports dr ON cv.report_id = dr.id
    WHERE cv.visit_type = 'supplier' AND dr.status != 'draft' ${dateFilter}
    GROUP BY s.id
    ORDER BY visit_count DESC
    LIMIT 20
  `;
  const supplierStmt = db.prepare(supplierQuery);
  if (params.length > 0) supplierStmt.bind(params);
  const suppliers = [];
  while (supplierStmt.step()) {
    suppliers.push(supplierStmt.getAsObject());
  }
  supplierStmt.free();

  // 訪問目的別件数
  const purposeQuery = `
    SELECT cv.visit_purpose as purpose, COUNT(*) as count
    FROM customer_visits cv
    JOIN daily_reports dr ON cv.report_id = dr.id
    WHERE dr.status != 'draft' ${dateFilter}
    GROUP BY cv.visit_purpose
    ORDER BY count DESC
  `;
  const purposeStmt = db.prepare(purposeQuery);
  if (params.length > 0) purposeStmt.bind(params);
  const purposes = [];
  while (purposeStmt.step()) {
    purposes.push(purposeStmt.getAsObject());
  }
  purposeStmt.free();

  // 全体集計
  const totalQuery = `
    SELECT 
      COUNT(*) as total_visits,
      SUM(CASE WHEN cv.visit_type = 'customer' THEN 1 ELSE 0 END) as customer_visits,
      SUM(CASE WHEN cv.visit_type = 'supplier' THEN 1 ELSE 0 END) as supplier_visits
    FROM customer_visits cv
    JOIN daily_reports dr ON cv.report_id = dr.id
    WHERE dr.status != 'draft' ${dateFilter}
  `;
  const totalStmt = db.prepare(totalQuery);
  if (params.length > 0) totalStmt.bind(params);
  totalStmt.step();
  const totals = totalStmt.getAsObject();
  totalStmt.free();

  res.json({
    customers,
    suppliers,
    purposes,
    totals
  });
});

// 月別統計API
app.get('/api/stats/monthly', requireAuth, (req, res) => {
  const { year, user_id } = req.query;
  const targetYear = parseInt(year) || new Date().getFullYear();
  const userId = req.session.user.id;
  const userRole = req.session.user.role;

  // 対象ユーザー決定
  // user_id指定なしor空 → 全員、user_id指定 → その人
  let targetUserId = null;
  if (user_id && user_id !== '') {
    targetUserId = parseInt(user_id);
  }
  // user_idが空または未指定なら全員(null)

  const months = [];

  for (let month = 1; month <= 12; month++) {
    const startDate = `${targetYear}-${String(month).padStart(2, '0')}-01`;
    const endDate = month === 12 
      ? `${targetYear + 1}-01-01`
      : `${targetYear}-${String(month + 1).padStart(2, '0')}-01`;

    // 担当訪問数
    let ownQuery = `
      SELECT COUNT(*) as count FROM customer_visits cv
      JOIN daily_reports dr ON cv.report_id = dr.id
      WHERE dr.status != 'draft' 
        AND dr.report_date >= ? AND dr.report_date < ?
    `;
    const ownParams = [startDate, endDate];
    if (targetUserId) {
      ownQuery += ' AND dr.user_id = ?';
      ownParams.push(targetUserId);
    }
    const ownStmt = db.prepare(ownQuery);
    ownStmt.bind(ownParams);
    ownStmt.step();
    const ownVisits = ownStmt.getAsObject().count;
    ownStmt.free();

    // 同行訪問数
    let compQuery = `
      SELECT COUNT(*) as count FROM visit_companions vc
      JOIN customer_visits cv ON vc.visit_id = cv.id
      JOIN daily_reports dr ON cv.report_id = dr.id
      WHERE dr.status != 'draft'
        AND dr.report_date >= ? AND dr.report_date < ?
    `;
    const compParams = [startDate, endDate];
    if (targetUserId) {
      compQuery += ' AND vc.user_id = ?';
      compParams.push(targetUserId);
    }
    const compStmt = db.prepare(compQuery);
    compStmt.bind(compParams);
    compStmt.step();
    const companionVisits = compStmt.getAsObject().count;
    compStmt.free();

    // 得意先・仕入先別
    let typeQuery = `
      SELECT 
        SUM(CASE WHEN cv.visit_type = 'customer' THEN 1 ELSE 0 END) as customer_visits,
        SUM(CASE WHEN cv.visit_type = 'supplier' THEN 1 ELSE 0 END) as supplier_visits
      FROM customer_visits cv
      JOIN daily_reports dr ON cv.report_id = dr.id
      WHERE dr.status != 'draft'
        AND dr.report_date >= ? AND dr.report_date < ?
    `;
    const typeParams = [startDate, endDate];
    if (targetUserId) {
      typeQuery += ' AND dr.user_id = ?';
      typeParams.push(targetUserId);
    }
    const typeStmt = db.prepare(typeQuery);
    typeStmt.bind(typeParams);
    typeStmt.step();
    const typeResult = typeStmt.getAsObject();
    typeStmt.free();

    // 日報数
    let reportQuery = `
      SELECT COUNT(*) as count FROM daily_reports
      WHERE status != 'draft'
        AND report_date >= ? AND report_date < ?
    `;
    const reportParams = [startDate, endDate];
    if (targetUserId) {
      reportQuery += ' AND user_id = ?';
      reportParams.push(targetUserId);
    }
    const reportStmt = db.prepare(reportQuery);
    reportStmt.bind(reportParams);
    reportStmt.step();
    const reportCount = reportStmt.getAsObject().count;
    reportStmt.free();

    months.push({
      month,
      own_visits: ownVisits,
      companion_visits: companionVisits,
      customer_visits: typeResult.customer_visits || 0,
      supplier_visits: typeResult.supplier_visits || 0,
      report_count: reportCount
    });
  }

  res.json({ year: targetYear, months });
});

// 年別統計API
app.get('/api/stats/yearly', requireAuth, (req, res) => {
  const { user_id } = req.query;
  const userId = req.session.user.id;
  const userRole = req.session.user.role;

  // 対象ユーザー決定
  // user_id指定なしor空 → 全員、user_id指定 → その人
  let targetUserId = null;
  if (user_id && user_id !== '') {
    targetUserId = parseInt(user_id);
  }
  // user_idが空または未指定なら全員(null)

  // 過去5年分を取得
  const currentYear = new Date().getFullYear();
  const years = [];

  for (let year = currentYear; year >= currentYear - 4; year--) {
    const startDate = `${year}-01-01`;
    const endDate = `${year + 1}-01-01`;

    // 担当訪問数
    let ownQuery = `
      SELECT COUNT(*) as count FROM customer_visits cv
      JOIN daily_reports dr ON cv.report_id = dr.id
      WHERE dr.status != 'draft'
        AND dr.report_date >= ? AND dr.report_date < ?
    `;
    const ownParams = [startDate, endDate];
    if (targetUserId) {
      ownQuery += ' AND dr.user_id = ?';
      ownParams.push(targetUserId);
    }
    const ownStmt = db.prepare(ownQuery);
    ownStmt.bind(ownParams);
    ownStmt.step();
    const ownVisits = ownStmt.getAsObject().count;
    ownStmt.free();

    // 同行訪問数
    let compQuery = `
      SELECT COUNT(*) as count FROM visit_companions vc
      JOIN customer_visits cv ON vc.visit_id = cv.id
      JOIN daily_reports dr ON cv.report_id = dr.id
      WHERE dr.status != 'draft'
        AND dr.report_date >= ? AND dr.report_date < ?
    `;
    const compParams = [startDate, endDate];
    if (targetUserId) {
      compQuery += ' AND vc.user_id = ?';
      compParams.push(targetUserId);
    }
    const compStmt = db.prepare(compQuery);
    compStmt.bind(compParams);
    compStmt.step();
    const companionVisits = compStmt.getAsObject().count;
    compStmt.free();

    // 日報数
    let reportQuery = `
      SELECT COUNT(*) as count FROM daily_reports
      WHERE status != 'draft'
        AND report_date >= ? AND report_date < ?
    `;
    const reportParams = [startDate, endDate];
    if (targetUserId) {
      reportQuery += ' AND user_id = ?';
      reportParams.push(targetUserId);
    }
    const reportStmt = db.prepare(reportQuery);
    reportStmt.bind(reportParams);
    reportStmt.step();
    const reportCount = reportStmt.getAsObject().count;
    reportStmt.free();

    years.push({
      year,
      own_visits: ownVisits,
      companion_visits: companionVisits,
      report_count: reportCount
    });
  }

  res.json(years);
});

// 仕入先一覧
app.get('/api/suppliers', requireAuth, (req, res) => {
  const { q, limit } = req.query;
  let query = 'SELECT * FROM suppliers';
  let params = [];
  
  if (q) {
    query += ' WHERE name LIKE ? OR supplier_code LIKE ?';
    params = [`%${q}%`, `%${q}%`];
  }
  query += ' ORDER BY supplier_code';
  
  // limitが指定された場合のみ制限
  if (limit && parseInt(limit) > 0) {
    query += ` LIMIT ${parseInt(limit)}`;
  }
  
  const results = [];
  const stmt = db.prepare(query);
  if (params.length > 0) {
    stmt.bind(params);
  }
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  res.json(results);
});

// ============================================
// お気に入り顧客API
// ============================================

// お気に入り一覧取得
app.get('/api/favorites', requireAuth, (req, res) => {
  const userId = req.session.user.id;
  const results = [];
  
  const stmt = db.prepare(`
    SELECT fc.*, 
           c.name as customer_name, c.customer_code,
           s.name as supplier_name, s.supplier_code
    FROM favorite_customers fc
    LEFT JOIN customers c ON fc.customer_id = c.id
    LEFT JOIN suppliers s ON fc.supplier_id = s.id
    WHERE fc.user_id = ?
    ORDER BY fc.sort_order, fc.created_at
  `);
  stmt.bind([userId]);
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  res.json(results);
});

// お気に入り追加
app.post('/api/favorites', requireAuth, (req, res) => {
  const userId = req.session.user.id;
  const { target_type, customer_id, supplier_id } = req.body;

  // 重複チェック
  const checkStmt = db.prepare(`
    SELECT id FROM favorite_customers 
    WHERE user_id = ? AND target_type = ? AND (customer_id = ? OR supplier_id = ?)
  `);
  checkStmt.bind([userId, target_type, customer_id || null, supplier_id || null]);
  if (checkStmt.step()) {
    checkStmt.free();
    return res.status(400).json({ error: '既にお気に入りに登録されています' });
  }
  checkStmt.free();

  db.run(
    'INSERT INTO favorite_customers (user_id, target_type, customer_id, supplier_id) VALUES (?, ?, ?, ?)',
    [userId, target_type, customer_id || null, supplier_id || null]
  );
  saveDatabase();
  res.json({ message: 'お気に入りに追加しました' });
});

// お気に入り削除
app.delete('/api/favorites/:id', requireAuth, (req, res) => {
  const userId = req.session.user.id;
  const favId = parseInt(req.params.id);

  db.run('DELETE FROM favorite_customers WHERE id = ? AND user_id = ?', [favId, userId]);
  saveDatabase();
  res.json({ message: 'お気に入りから削除しました' });
});

// ============================================
// テンプレートAPI
// ============================================

// テンプレート一覧取得
app.get('/api/templates', requireAuth, (req, res) => {
  const userId = req.session.user.id;
  const results = [];
  
  const stmt = db.prepare(`
    SELECT t.*, u.name as user_name
    FROM report_templates t
    JOIN users u ON t.user_id = u.id
    WHERE t.user_id = ? OR t.is_shared = 1
    ORDER BY t.user_id = ? DESC, t.name
  `);
  stmt.bind([userId, userId]);
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  res.json(results);
});

// テンプレート作成
app.post('/api/templates', requireAuth, (req, res) => {
  const userId = req.session.user.id;
  const { name, work_content, achievements, issues, consultation, is_shared } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'テンプレート名は必須です' });
  }

  db.run(
    `INSERT INTO report_templates (user_id, name, work_content, achievements, issues, consultation, is_shared) 
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [userId, name, work_content || null, achievements || null, issues || null, consultation || null, is_shared ? 1 : 0]
  );
  const id = db.exec('SELECT last_insert_rowid() as id')[0].values[0][0];
  saveDatabase();
  res.json({ id, message: 'テンプレートを作成しました' });
});

// テンプレート更新
app.put('/api/templates/:id', requireAuth, (req, res) => {
  const userId = req.session.user.id;
  const templateId = parseInt(req.params.id);
  const { name, work_content, achievements, issues, consultation, is_shared } = req.body;

  // 所有者チェック
  const checkStmt = db.prepare('SELECT user_id FROM report_templates WHERE id = ?');
  checkStmt.bind([templateId]);
  if (!checkStmt.step()) {
    checkStmt.free();
    return res.status(404).json({ error: 'テンプレートが見つかりません' });
  }
  const owner = checkStmt.getAsObject();
  checkStmt.free();

  if (owner.user_id !== userId) {
    return res.status(403).json({ error: '編集権限がありません' });
  }

  db.run(
    `UPDATE report_templates SET name = ?, work_content = ?, achievements = ?, issues = ?, consultation = ?, is_shared = ?, updated_at = datetime('now', '+9 hours') WHERE id = ?`,
    [name, work_content || null, achievements || null, issues || null, consultation || null, is_shared ? 1 : 0, templateId]
  );
  saveDatabase();
  res.json({ message: 'テンプレートを更新しました' });
});

// テンプレート削除
app.delete('/api/templates/:id', requireAuth, (req, res) => {
  const userId = req.session.user.id;
  const templateId = parseInt(req.params.id);

  db.run('DELETE FROM report_templates WHERE id = ? AND user_id = ?', [templateId, userId]);
  saveDatabase();
  res.json({ message: 'テンプレートを削除しました' });
});

// ============================================
// 前日日報コピーAPI
// ============================================

app.get('/api/reports/copy/latest', requireAuth, (req, res) => {
  const userId = req.session.user.id;
  const { before_date } = req.query;

  let query = `
    SELECT dr.* FROM daily_reports dr
    WHERE dr.user_id = ?
  `;
  const params = [userId];

  if (before_date) {
    query += ' AND dr.report_date < ?';
    params.push(before_date);
  }
  query += ' ORDER BY dr.report_date DESC LIMIT 1';

  const stmt = db.prepare(query);
  stmt.bind(params);
  
  if (!stmt.step()) {
    stmt.free();
    return res.status(404).json({ error: 'コピー元の日報が見つかりません' });
  }
  
  const report = stmt.getAsObject();
  stmt.free();

  // タスク取得
  const tasks = [];
  const taskStmt = db.prepare('SELECT * FROM tasks WHERE report_id = ?');
  taskStmt.bind([report.id]);
  while (taskStmt.step()) {
    tasks.push(taskStmt.getAsObject());
  }
  taskStmt.free();

  // 訪問記録取得
  const visits = [];
  const visitStmt = db.prepare(`
    SELECT cv.*, c.name as customer_name, s.name as supplier_name
    FROM customer_visits cv
    LEFT JOIN customers c ON cv.customer_id = c.id
    LEFT JOIN suppliers s ON cv.supplier_id = s.id
    WHERE cv.report_id = ?
  `);
  visitStmt.bind([report.id]);
  while (visitStmt.step()) {
    const visit = visitStmt.getAsObject();
    
    // メーカー取得
    const mfrStmt = db.prepare(`
      SELECT m.id, m.name FROM visit_manufacturers vm
      JOIN manufacturers m ON vm.manufacturer_id = m.id
      WHERE vm.visit_id = ?
    `);
    mfrStmt.bind([visit.id]);
    visit.manufacturers = [];
    while (mfrStmt.step()) {
      visit.manufacturers.push(mfrStmt.getAsObject());
    }
    mfrStmt.free();

    // 同行者取得
    const compStmt = db.prepare(`
      SELECT u.id, u.name FROM visit_companions vc
      JOIN users u ON vc.user_id = u.id
      WHERE vc.visit_id = ?
    `);
    compStmt.bind([visit.id]);
    visit.companions = [];
    while (compStmt.step()) {
      visit.companions.push(compStmt.getAsObject());
    }
    compStmt.free();

    visits.push(visit);
  }
  visitStmt.free();

  res.json({
    ...report,
    tasks,
    visits
  });
});

// ============================================
// カレンダーAPI
// ============================================

app.get('/api/calendar', requireAuth, (req, res) => {
  const currentUserId = req.session.user.id;
  const { year, month, user_id } = req.query;

  if (!year || !month) {
    return res.status(400).json({ error: '年月を指定してください' });
  }

  const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
  const endDate = `${year}-${String(month).padStart(2, '0')}-31`;

  let query, params;

  // user_id='all'の場合は全員分を取得
  if (user_id === 'all') {
    query = `
      SELECT dr.id, dr.report_date, dr.status, dr.work_style, dr.user_id,
             u.name as user_name,
             (SELECT COUNT(*) FROM customer_visits WHERE report_id = dr.id) as visit_count
      FROM daily_reports dr
      JOIN users u ON dr.user_id = u.id
      WHERE dr.report_date BETWEEN ? AND ? AND dr.status != 'draft'
      ORDER BY dr.report_date, u.name
    `;
    params = [startDate, endDate];
  } else {
    // user_idが指定されていればその人、なければ自分
    const targetUserId = user_id ? parseInt(user_id) : currentUserId;
    query = `
      SELECT dr.id, dr.report_date, dr.status, dr.work_style, dr.user_id,
             (SELECT COUNT(*) FROM customer_visits WHERE report_id = dr.id) as visit_count
      FROM daily_reports dr
      WHERE dr.user_id = ? AND dr.report_date BETWEEN ? AND ?
      ORDER BY dr.report_date
    `;
    params = [targetUserId, startDate, endDate];
  }

  const results = [];
  const stmt = db.prepare(query);
  stmt.bind(params);
  while (stmt.step()) {
    const report = stmt.getAsObject();
    
    // 訪問先情報を取得
    const visitStmt = db.prepare(`
      SELECT cv.visit_type, 
             c.name as customer_name, 
             s.name as supplier_name,
             cv.customer_name_manual
      FROM customer_visits cv
      LEFT JOIN customers c ON cv.customer_id = c.id
      LEFT JOIN suppliers s ON cv.supplier_id = s.id
      WHERE cv.report_id = ?
    `);
    visitStmt.bind([report.id]);
    report.visits = [];
    while (visitStmt.step()) {
      const visit = visitStmt.getAsObject();
      report.visits.push({
        type: visit.visit_type,
        name: visit.customer_name || visit.supplier_name || visit.customer_name_manual || ''
      });
    }
    visitStmt.free();
    
    results.push(report);
  }
  stmt.free();
  res.json(results);
});

// ============================================
// 全文検索API
// ============================================

app.get('/api/search', requireAuth, (req, res) => {
  const userId = req.session.user.id;
  const userRole = req.session.user.role;
  const userDeptId = req.session.user.department_id;
  const { q, from, to, user_id } = req.query;

  if (!q || q.length < 2) {
    return res.status(400).json({ error: '検索キーワードは2文字以上入力してください' });
  }

  const keyword = `%${q}%`;
  let query = `
    SELECT DISTINCT dr.id, dr.report_date, dr.status, dr.work_content,
           u.name as user_name, d.name as department_name,
           (SELECT GROUP_CONCAT(COALESCE(c.name, cv.customer_name_manual), ', ') 
            FROM customer_visits cv 
            LEFT JOIN customers c ON cv.customer_id = c.id 
            WHERE cv.report_id = dr.id) as visit_names
    FROM daily_reports dr
    JOIN users u ON dr.user_id = u.id
    LEFT JOIN departments d ON u.department_id = d.id
    LEFT JOIN customer_visits cv ON cv.report_id = dr.id
    LEFT JOIN customers c ON cv.customer_id = c.id
    WHERE (
      dr.work_content LIKE ? OR
      dr.achievements LIKE ? OR
      dr.issues LIKE ? OR
      dr.consultation LIKE ? OR
      cv.meeting_content LIKE ? OR
      c.name LIKE ?
    )
  `;
  const params = [keyword, keyword, keyword, keyword, keyword, keyword];

  // 権限によるフィルター
  if (userRole === 'sales') {
    query += ' AND dr.user_id = ?';
    params.push(userId);
  } else if (userRole === 'manager') {
    query += ' AND (dr.user_id = ? OR u.department_id = ?)';
    params.push(userId, userDeptId);
  }
  // admin, assistantは全員見える

  if (user_id) {
    query += ' AND dr.user_id = ?';
    params.push(parseInt(user_id));
  }
  if (from) {
    query += ' AND dr.report_date >= ?';
    params.push(from);
  }
  if (to) {
    query += ' AND dr.report_date <= ?';
    params.push(to);
  }

  query += ' ORDER BY dr.report_date DESC LIMIT 100';

  const results = [];
  const stmt = db.prepare(query);
  stmt.bind(params);
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  res.json(results);
});

// ============================================
// 顧客別活動履歴API
// ============================================

app.get('/api/customer-history/:id', requireAuth, (req, res) => {
  const customerId = parseInt(req.params.id);
  const { type } = req.query; // 'customer' or 'supplier'

  let visitCondition = type === 'supplier' ? 'cv.supplier_id = ?' : 'cv.customer_id = ?';
  
  // 訪問履歴取得（全ユーザー分）
  let query = `
    SELECT cv.*, dr.report_date, dr.status, dr.user_id,
           u.name as user_name, d.name as department_name,
           c.name as customer_name, s.name as supplier_name
    FROM customer_visits cv
    JOIN daily_reports dr ON cv.report_id = dr.id
    JOIN users u ON dr.user_id = u.id
    LEFT JOIN departments d ON u.department_id = d.id
    LEFT JOIN customers c ON cv.customer_id = c.id
    LEFT JOIN suppliers s ON cv.supplier_id = s.id
    WHERE ${visitCondition} AND dr.status != 'draft'
    ORDER BY dr.report_date DESC
    LIMIT 100
  `;
  
  const results = [];
  const stmt = db.prepare(query);
  stmt.bind([customerId]);
  while (stmt.step()) {
    const visit = stmt.getAsObject();
    
    // メーカー取得
    const mfrStmt = db.prepare(`
      SELECT m.name FROM visit_manufacturers vm
      JOIN manufacturers m ON vm.manufacturer_id = m.id
      WHERE vm.visit_id = ?
    `);
    mfrStmt.bind([visit.id]);
    visit.manufacturers = [];
    while (mfrStmt.step()) {
      visit.manufacturers.push(mfrStmt.getAsObject().name);
    }
    mfrStmt.free();

    results.push(visit);
  }
  stmt.free();

  // 顧客/仕入先情報も返す
  let targetInfo = null;
  if (type === 'supplier') {
    const infoStmt = db.prepare('SELECT * FROM suppliers WHERE id = ?');
    infoStmt.bind([customerId]);
    if (infoStmt.step()) targetInfo = infoStmt.getAsObject();
    infoStmt.free();
  } else {
    const infoStmt = db.prepare('SELECT * FROM customers WHERE id = ?');
    infoStmt.bind([customerId]);
    if (infoStmt.step()) targetInfo = infoStmt.getAsObject();
    infoStmt.free();
  }

  // === 顧客カルテ追加情報 ===

  // 1. 担当者一覧（訪問したことがある営業担当者）
  const salesReps = [];
  const repQuery = `
    SELECT u.id, u.name, d.name as department_name, 
           COUNT(*) as visit_count,
           MAX(dr.report_date) as last_visit
    FROM customer_visits cv
    JOIN daily_reports dr ON cv.report_id = dr.id
    JOIN users u ON dr.user_id = u.id
    LEFT JOIN departments d ON u.department_id = d.id
    WHERE ${visitCondition} AND dr.status != 'draft'
    GROUP BY u.id
    ORDER BY visit_count DESC
  `;
  const repStmt = db.prepare(repQuery);
  repStmt.bind([customerId]);
  while (repStmt.step()) {
    salesReps.push(repStmt.getAsObject());
  }
  repStmt.free();

  // 2. 主要メーカー（よく商談に出てくるメーカー）
  const topManufacturers = [];
  const mfrQuery = `
    SELECT m.id, m.name, COUNT(*) as mention_count
    FROM visit_manufacturers vm
    JOIN manufacturers m ON vm.manufacturer_id = m.id
    JOIN customer_visits cv ON vm.visit_id = cv.id
    JOIN daily_reports dr ON cv.report_id = dr.id
    WHERE ${visitCondition} AND dr.status != 'draft'
    GROUP BY m.id
    ORDER BY mention_count DESC
    LIMIT 10
  `;
  const mfrStatStmt = db.prepare(mfrQuery);
  mfrStatStmt.bind([customerId]);
  while (mfrStatStmt.step()) {
    topManufacturers.push(mfrStatStmt.getAsObject());
  }
  mfrStatStmt.free();

  // 3. 月別訪問数（過去12ヶ月）
  const monthlyVisits = [];
  const now = new Date();
  for (let i = 11; i >= 0; i--) {
    const targetDate = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const yearMonth = `${targetDate.getFullYear()}-${String(targetDate.getMonth() + 1).padStart(2, '0')}`;
    const startDate = `${yearMonth}-01`;
    const endDate = new Date(targetDate.getFullYear(), targetDate.getMonth() + 1, 0)
      .toISOString().slice(0, 10);

    const countQuery = `
      SELECT COUNT(*) as count
      FROM customer_visits cv
      JOIN daily_reports dr ON cv.report_id = dr.id
      WHERE ${visitCondition} AND dr.status != 'draft'
        AND dr.report_date >= ? AND dr.report_date <= ?
    `;
    const countStmt = db.prepare(countQuery);
    countStmt.bind([customerId, startDate, endDate]);
    countStmt.step();
    const count = countStmt.getAsObject().count;
    countStmt.free();

    monthlyVisits.push({
      month: yearMonth,
      label: `${targetDate.getMonth() + 1}月`,
      count: count
    });
  }

  // 4. 訪問目的別集計
  const purposeStats = [];
  const purposeQuery = `
    SELECT cv.visit_purpose, COUNT(*) as count
    FROM customer_visits cv
    JOIN daily_reports dr ON cv.report_id = dr.id
    WHERE ${visitCondition} AND dr.status != 'draft'
    GROUP BY cv.visit_purpose
    ORDER BY count DESC
  `;
  const purposeStmt = db.prepare(purposeQuery);
  purposeStmt.bind([customerId]);
  while (purposeStmt.step()) {
    purposeStats.push(purposeStmt.getAsObject());
  }
  purposeStmt.free();

  // 5. 最初と最後の訪問日
  let firstVisit = null, lastVisit = null;
  if (results.length > 0) {
    lastVisit = results[0].report_date;
    firstVisit = results[results.length - 1].report_date;
  }

  res.json({ 
    target: targetInfo, 
    visits: results,
    // カルテ追加情報
    salesReps,
    topManufacturers,
    monthlyVisits,
    purposeStats,
    firstVisit,
    lastVisit
  });
});

// ============================================
// 週報生成API
// ============================================

app.get('/api/weekly-report', requireAuth, (req, res) => {
  const userId = req.session.user.id;
  const { start_date, end_date, target_user_id } = req.query;

  if (!start_date || !end_date) {
    return res.status(400).json({ error: '期間を指定してください' });
  }

  const targetUserId = target_user_id ? parseInt(target_user_id) : userId;

  // 権限チェック（アシスタントも他ユーザーの日報を閲覧可能）
  const userRole = req.session.user.role;
  if (targetUserId !== userId && userRole === 'sales') {
    return res.status(403).json({ error: '権限がありません' });
  }

  // 日報取得
  const reports = [];
  const reportStmt = db.prepare(`
    SELECT dr.*, u.name as user_name, d.name as department_name
    FROM daily_reports dr
    JOIN users u ON dr.user_id = u.id
    LEFT JOIN departments d ON u.department_id = d.id
    WHERE dr.user_id = ? AND dr.report_date BETWEEN ? AND ? AND dr.status != 'draft'
    ORDER BY dr.report_date
  `);
  reportStmt.bind([targetUserId, start_date, end_date]);
  while (reportStmt.step()) {
    const report = reportStmt.getAsObject();
    
    // 訪問記録取得
    const visitStmt = db.prepare(`
      SELECT cv.*, c.name as customer_name, s.name as supplier_name
      FROM customer_visits cv
      LEFT JOIN customers c ON cv.customer_id = c.id
      LEFT JOIN suppliers s ON cv.supplier_id = s.id
      WHERE cv.report_id = ?
    `);
    visitStmt.bind([report.id]);
    report.visits = [];
    while (visitStmt.step()) {
      report.visits.push(visitStmt.getAsObject());
    }
    visitStmt.free();

    reports.push(report);
  }
  reportStmt.free();

  // 集計
  const summary = {
    total_reports: reports.length,
    total_visits: 0,
    customer_visits: 0,
    supplier_visits: 0,
    total_deal_amount: 0,
    visited_customers: new Set(),
    visited_suppliers: new Set()
  };

  reports.forEach(r => {
    r.visits.forEach(v => {
      summary.total_visits++;
      if (v.visit_type === 'supplier') {
        summary.supplier_visits++;
        if (v.supplier_id) summary.visited_suppliers.add(v.supplier_name);
      } else {
        summary.customer_visits++;
        if (v.customer_id) summary.visited_customers.add(v.customer_name);
      }
      if (v.deal_amount) summary.total_deal_amount += v.deal_amount;
    });
  });

  summary.visited_customers = Array.from(summary.visited_customers);
  summary.visited_suppliers = Array.from(summary.visited_suppliers);

  // ユーザー情報
  let userInfo = null;
  const userStmt = db.prepare(`
    SELECT u.name, d.name as department_name 
    FROM users u LEFT JOIN departments d ON u.department_id = d.id 
    WHERE u.id = ?
  `);
  userStmt.bind([targetUserId]);
  if (userStmt.step()) userInfo = userStmt.getAsObject();
  userStmt.free();

  res.json({
    user: userInfo,
    period: { start_date, end_date },
    summary,
    reports
  });
});

// チーム週次サマリーAPI
app.get('/api/weekly-summary', requireAuth, (req, res) => {
  const { start_date, end_date, department_id } = req.query;

  if (!start_date || !end_date) {
    return res.status(400).json({ error: '期間を指定してください' });
  }

  // 全員の日報を取得
  let reportsQuery = `
    SELECT dr.*, u.id as user_id, u.name as user_name, d.name as department_name
    FROM daily_reports dr
    JOIN users u ON dr.user_id = u.id
    LEFT JOIN departments d ON u.department_id = d.id
    WHERE dr.report_date BETWEEN ? AND ? AND dr.status != 'draft'
  `;
  const params = [start_date, end_date];

  if (department_id) {
    reportsQuery += ' AND u.department_id = ?';
    params.push(parseInt(department_id));
  }

  reportsQuery += ' ORDER BY dr.report_date, u.name';

  const reports = [];
  const reportStmt = db.prepare(reportsQuery);
  reportStmt.bind(params);
  while (reportStmt.step()) {
    const report = reportStmt.getAsObject();
    
    // 訪問記録取得
    const visitStmt = db.prepare(`
      SELECT cv.*, c.name as customer_name, s.name as supplier_name
      FROM customer_visits cv
      LEFT JOIN customers c ON cv.customer_id = c.id
      LEFT JOIN suppliers s ON cv.supplier_id = s.id
      WHERE cv.report_id = ?
    `);
    visitStmt.bind([report.id]);
    report.visits = [];
    while (visitStmt.step()) {
      const visit = visitStmt.getAsObject();
      // メーカー取得
      const mfrStmt = db.prepare(`
        SELECT m.name FROM visit_manufacturers vm
        JOIN manufacturers m ON vm.manufacturer_id = m.id
        WHERE vm.visit_id = ?
      `);
      mfrStmt.bind([visit.id]);
      visit.manufacturers = [];
      while (mfrStmt.step()) {
        visit.manufacturers.push(mfrStmt.getAsObject().name);
      }
      mfrStmt.free();
      report.visits.push(visit);
    }
    visitStmt.free();

    reports.push(report);
  }
  reportStmt.free();

  // チーム全体の集計
  const teamSummary = {
    total_reports: reports.length,
    total_visits: 0,
    customer_visits: 0,
    supplier_visits: 0,
    total_deal_amount: 0,
    visited_customers: new Set(),
    visited_suppliers: new Set(),
    manufacturers: {}
  };

  // メンバー別集計
  const memberStats = {};

  reports.forEach(r => {
    // メンバー初期化
    if (!memberStats[r.user_id]) {
      memberStats[r.user_id] = {
        user_id: r.user_id,
        user_name: r.user_name,
        department_name: r.department_name,
        report_count: 0,
        visit_count: 0,
        customer_visits: 0,
        supplier_visits: 0,
        deal_amount: 0,
        customers: new Set(),
        suppliers: new Set(),
        highlights: []
      };
    }
    const member = memberStats[r.user_id];
    member.report_count++;

    r.visits.forEach(v => {
      teamSummary.total_visits++;
      member.visit_count++;

      if (v.visit_type === 'supplier') {
        teamSummary.supplier_visits++;
        member.supplier_visits++;
        if (v.supplier_name) {
          teamSummary.visited_suppliers.add(v.supplier_name);
          member.suppliers.add(v.supplier_name);
        }
      } else {
        teamSummary.customer_visits++;
        member.customer_visits++;
        // customer_nameまたはcustomer_name_manual（手動入力）を使用
        const customerDisplayName = v.customer_name || v.customer_name_manual;
        if (customerDisplayName) {
          teamSummary.visited_customers.add(customerDisplayName);
          member.customers.add(customerDisplayName);
        }
      }

      if (v.deal_amount) {
        teamSummary.total_deal_amount += v.deal_amount;
        member.deal_amount += v.deal_amount;
      }

      // メーカー集計
      v.manufacturers.forEach(m => {
        teamSummary.manufacturers[m] = (teamSummary.manufacturers[m] || 0) + 1;
      });

      // ハイライト（金額大きい、次回アクションあり）
      if (v.deal_amount >= 100000 || v.next_action) {
        member.highlights.push({
          date: r.report_date,
          target: v.customer_name || v.supplier_name || v.customer_name_manual,
          content: v.meeting_content ? v.meeting_content.slice(0, 100) : '',
          amount: v.deal_amount,
          next_action: v.next_action
        });
      }
    });
  });

  // Set→配列変換
  teamSummary.visited_customers = Array.from(teamSummary.visited_customers);
  teamSummary.visited_suppliers = Array.from(teamSummary.visited_suppliers);

  // メーカーをソートして上位取得
  teamSummary.top_manufacturers = Object.entries(teamSummary.manufacturers)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, count]) => ({ name, count }));
  delete teamSummary.manufacturers;

  // メンバー配列化
  const members = Object.values(memberStats).map(m => ({
    ...m,
    customers: Array.from(m.customers),
    suppliers: Array.from(m.suppliers),
    highlights: m.highlights.slice(0, 5) // 上位5件
  })).sort((a, b) => b.visit_count - a.visit_count);

  // 重要キーワード検出
  const keywordPatterns = {
    positive: ['受注', '成約', '決定', '採用', '契約', '合意'],
    alert: ['クレーム', '失注', 'トラブル', '返品', '解約'],
    opportunity: ['見積依頼', '提案', 'コンペ', '案件化']
  };

  const keywords = { positive: [], alert: [], opportunity: [] };
  reports.forEach(r => {
    const content = (r.work_content || '') + (r.achievements || '') + 
      r.visits.map(v => v.meeting_content || '').join(' ');
    
    Object.entries(keywordPatterns).forEach(([type, patterns]) => {
      patterns.forEach(kw => {
        if (content.includes(kw)) {
          keywords[type].push({
            keyword: kw,
            user: r.user_name,
            date: r.report_date
          });
        }
      });
    });
  });

  res.json({
    period: { start_date, end_date },
    teamSummary,
    members,
    keywords,
    report_count_by_date: getReportCountByDate(reports)
  });

  function getReportCountByDate(reports) {
    const counts = {};
    reports.forEach(r => {
      counts[r.report_date] = (counts[r.report_date] || 0) + 1;
    });
    return Object.entries(counts).map(([date, count]) => ({ date, count }));
  }
});

// 未訪問顧客アラートAPI（得意先のみ）
app.get('/api/unvisited-alerts', requireAuth, (req, res) => {
  const { days = 30 } = req.query;
  const thresholdDays = parseInt(days);
  const today = new Date().toISOString().slice(0, 10);

  const results = [];

  // 得意先の未訪問チェック
  const customerQuery = `
    SELECT c.id, c.name, c.customer_code as code, 'customer' as target_type,
           MAX(dr.report_date) as last_visit_date,
           u.name as last_visitor_name,
           julianday(?) - julianday(MAX(dr.report_date)) as days_since_visit
    FROM customers c
    LEFT JOIN customer_visits cv ON c.id = cv.customer_id
    LEFT JOIN daily_reports dr ON cv.report_id = dr.id AND dr.status != 'draft'
    LEFT JOIN users u ON dr.user_id = u.id
    GROUP BY c.id
    HAVING last_visit_date IS NOT NULL 
       AND days_since_visit >= ?
    ORDER BY days_since_visit DESC
  `;
  const custStmt = db.prepare(customerQuery);
  custStmt.bind([today, thresholdDays]);
  while (custStmt.step()) {
    results.push(custStmt.getAsObject());
  }
  custStmt.free();

  // 一度も訪問されていない得意先
  const neverVisitedCustomerQuery = `
    SELECT c.id, c.name, c.customer_code as code, 'customer' as target_type,
           NULL as last_visit_date,
           NULL as last_visitor_name,
           9999 as days_since_visit
    FROM customers c
    WHERE NOT EXISTS (
      SELECT 1 FROM customer_visits cv
      JOIN daily_reports dr ON cv.report_id = dr.id AND dr.status != 'draft'
      WHERE cv.customer_id = c.id
    )
    ORDER BY c.name
  `;
  const neverCustStmt = db.prepare(neverVisitedCustomerQuery);
  while (neverCustStmt.step()) {
    results.push(neverCustStmt.getAsObject());
  }
  neverCustStmt.free();

  // 日数でソート
  results.sort((a, b) => b.days_since_visit - a.days_since_visit);

  // 集計
  const summary = {
    total: results.length,
    never_visited: results.filter(r => r.days_since_visit === 9999).length,
    over_90_days: results.filter(r => r.days_since_visit >= 90 && r.days_since_visit < 9999).length,
    over_60_days: results.filter(r => r.days_since_visit >= 60 && r.days_since_visit < 90).length,
    over_30_days: results.filter(r => r.days_since_visit >= 30 && r.days_since_visit < 60).length
  };

  res.json({ summary, alerts: results });
});

// 今月のランキングAPI
app.get('/api/rankings/monthly', requireAuth, (req, res) => {
  try {
    // 日本時間で今月の範囲を計算
    const now = new Date();
    const jstNow = new Date(now.getTime() + (9 * 60 * 60 * 1000));
    const year = jstNow.getUTCFullYear();
    const month = jstNow.getUTCMonth();
    
    const firstDay = `${year}-${String(month + 1).padStart(2, '0')}-01`;
    const lastDayDate = new Date(Date.UTC(year, month + 1, 0));
    const lastDay = `${year}-${String(month + 1).padStart(2, '0')}-${String(lastDayDate.getUTCDate()).padStart(2, '0')}`;

    // 1. 日報提出ランキング
    const reportRanking = [];
    const reportStmt = db.prepare(`
      SELECT u.id, u.name, COUNT(*) as count
      FROM daily_reports dr
      JOIN users u ON dr.user_id = u.id
      WHERE dr.report_date BETWEEN ? AND ? AND dr.status != 'draft'
      GROUP BY u.id
      ORDER BY count DESC
      LIMIT 3
    `);
    reportStmt.bind([firstDay, lastDay]);
    while (reportStmt.step()) {
      reportRanking.push(reportStmt.getAsObject());
    }
    reportStmt.free();

    // 2. 同行訪問ランキング（同行者として名前が記録されている回数）
    const companionRanking = [];
    const companionStmt = db.prepare(`
      SELECT u.id, u.name, COUNT(*) as count
      FROM visit_companions vc
      JOIN customer_visits cv ON vc.visit_id = cv.id
      JOIN daily_reports dr ON cv.report_id = dr.id
      JOIN users u ON vc.user_id = u.id
      WHERE dr.report_date BETWEEN ? AND ? AND dr.status != 'draft'
      GROUP BY u.id
      ORDER BY count DESC
      LIMIT 3
    `);
    companionStmt.bind([firstDay, lastDay]);
    while (companionStmt.step()) {
      companionRanking.push(companionStmt.getAsObject());
    }
    companionStmt.free();

    // 3. 訪問先数ランキング（ユニークな得意先・仕入先数）
    const targetRanking = [];
    const targetStmt = db.prepare(`
      SELECT u.id, u.name, 
             COUNT(DISTINCT COALESCE(cv.customer_id, 'c_' || cv.customer_name_manual, 's_' || cv.supplier_id)) as count
      FROM customer_visits cv
      JOIN daily_reports dr ON cv.report_id = dr.id
      JOIN users u ON dr.user_id = u.id
      WHERE dr.report_date BETWEEN ? AND ? AND dr.status != 'draft'
      GROUP BY u.id
      ORDER BY count DESC
      LIMIT 3
    `);
    targetStmt.bind([firstDay, lastDay]);
    while (targetStmt.step()) {
      targetRanking.push(targetStmt.getAsObject());
    }
    targetStmt.free();

    res.json({
      period: { from: firstDay, to: lastDay },
      reports: reportRanking,
      companion: companionRanking,
      targets: targetRanking
    });
  } catch (error) {
    console.error('ランキングAPI エラー:', error);
    res.status(500).json({ error: 'ランキングの取得に失敗しました' });
  }
});

// ============================================
// 日報API
// ============================================

// 自分の日報一覧
app.get('/api/reports', requireAuth, (req, res) => {
  const userId = req.session.user.id;
  const { status, from, to } = req.query;
  
  let query = `
    SELECT dr.*, u.name as user_name, d.name as department_name
    FROM daily_reports dr
    JOIN users u ON dr.user_id = u.id
    LEFT JOIN departments d ON u.department_id = d.id
    WHERE dr.user_id = ?
  `;
  const params = [userId];
  
  if (status) {
    query += ' AND dr.status = ?';
    params.push(status);
  }
  if (from) {
    query += ' AND dr.report_date >= ?';
    params.push(from);
  }
  if (to) {
    query += ' AND dr.report_date <= ?';
    params.push(to);
  }
  
  query += ' ORDER BY dr.report_date DESC LIMIT 50';
  
  const results = [];
  const stmt = db.prepare(query);
  stmt.bind(params);
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();

  // 各日報の訪問先を取得
  results.forEach(report => {
    const visitStmt = db.prepare(`
      SELECT cv.*, c.name as customer_name, s.name as supplier_name
      FROM customer_visits cv
      LEFT JOIN customers c ON cv.customer_id = c.id
      LEFT JOIN suppliers s ON cv.supplier_id = s.id
      WHERE cv.report_id = ?
    `);
    visitStmt.bind([report.id]);
    const visits = [];
    while (visitStmt.step()) {
      const v = visitStmt.getAsObject();
      v.target_name = v.customer_name || v.supplier_name || v.customer_name_manual || '';
      visits.push(v);
    }
    visitStmt.free();
    report.visits = visits;
  });

  res.json(results);
});

// 日報詳細取得
app.get('/api/reports/:id', requireAuth, (req, res) => {
  const reportId = parseInt(req.params.id);
  const userId = req.session.user.id;
  const userRole = req.session.user.role;
  
  // 日報本体
  const stmt = db.prepare(`
    SELECT dr.*, u.name as user_name, u.department_id, d.name as department_name,
           cu.name as confirmed_by_name
    FROM daily_reports dr
    JOIN users u ON dr.user_id = u.id
    LEFT JOIN departments d ON u.department_id = d.id
    LEFT JOIN users cu ON dr.confirmed_by = cu.id
    WHERE dr.id = ?
  `);
  stmt.bind([reportId]);
  
  let report = null;
  if (stmt.step()) {
    report = stmt.getAsObject();
  }
  stmt.free();
  
  if (!report) {
    return res.status(404).json({ error: '日報が見つかりません' });
  }
  
  // 下書きは本人のみ閲覧可能
  if (report.status === 'draft' && report.user_id !== userId) {
    return res.status(403).json({ error: '閲覧権限がありません' });
  }
  // 提出済み以上は全員閲覧可能
  
  // タスク
  const tasks = [];
  const taskStmt = db.prepare('SELECT * FROM tasks WHERE report_id = ?');
  taskStmt.bind([reportId]);
  while (taskStmt.step()) {
    tasks.push(taskStmt.getAsObject());
  }
  taskStmt.free();
  
  // 顧客訪問
  const visits = [];
  const visitStmt = db.prepare(`
    SELECT cv.*, c.name as customer_name, c.customer_code,
           s.name as supplier_name, s.supplier_code
    FROM customer_visits cv
    LEFT JOIN customers c ON cv.customer_id = c.id
    LEFT JOIN suppliers s ON cv.supplier_id = s.id
    WHERE cv.report_id = ?
  `);
  visitStmt.bind([reportId]);
  while (visitStmt.step()) {
    visits.push(visitStmt.getAsObject());
  }
  visitStmt.free();
  
  // 訪問ごとのメーカーと同行者
  for (const visit of visits) {
    visit.manufacturers = [];
    const mfrStmt = db.prepare(`
      SELECT m.* FROM manufacturers m
      JOIN visit_manufacturers vm ON m.id = vm.manufacturer_id
      WHERE vm.visit_id = ?
    `);
    mfrStmt.bind([visit.id]);
    while (mfrStmt.step()) {
      visit.manufacturers.push(mfrStmt.getAsObject());
    }
    mfrStmt.free();

    // 同行者
    visit.companions = [];
    const compStmt = db.prepare(`
      SELECT u.id, u.name FROM users u
      JOIN visit_companions vc ON u.id = vc.user_id
      WHERE vc.visit_id = ?
    `);
    compStmt.bind([visit.id]);
    while (compStmt.step()) {
      visit.companions.push(compStmt.getAsObject());
    }
    compStmt.free();
  }
  
  // コメント
  const comments = [];
  const commentStmt = db.prepare(`
    SELECT c.*, u.name as user_name
    FROM comments c
    JOIN users u ON c.user_id = u.id
    WHERE c.report_id = ?
    ORDER BY c.created_at
  `);
  commentStmt.bind([reportId]);
  while (commentStmt.step()) {
    comments.push(commentStmt.getAsObject());
  }
  commentStmt.free();
  
  res.json({
    ...report,
    tasks,
    visits,
    comments
  });
});

// 日報作成
app.post('/api/reports', requireAuth, (req, res) => {
  const userId = req.session.user.id;
  const {
    report_date,
    work_style,
    work_content,
    achievements,
    issues,
    consultation,
    status,
    tasks,
    visits
  } = req.body;
  
  try {
    db.run(`
      INSERT INTO daily_reports 
      (user_id, report_date, work_style, work_content, achievements, issues, consultation, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [userId, report_date, work_style || null, work_content || null, achievements || null,
        issues || null, consultation || null, status || 'draft']);
    
    const reportId = db.exec('SELECT last_insert_rowid() as id')[0].values[0][0];
    
    // タスク登録
    if (tasks && tasks.length > 0) {
      for (const task of tasks) {
        db.run('INSERT INTO tasks (report_id, content, is_completed, due_date) VALUES (?, ?, ?, ?)',
          [reportId, task.content, task.is_completed ? 1 : 0, task.due_date || null]);
      }
    }
    
    // 顧客訪問登録
    if (visits && visits.length > 0) {
      for (const visit of visits) {
        db.run(`
          INSERT INTO customer_visits 
          (report_id, visit_type, customer_id, supplier_id, customer_name_manual, visit_purpose, meeting_content, deal_amount, probability, next_action, next_action_date)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [reportId, visit.visit_type || 'customer', visit.customer_id || null, visit.supplier_id || null, visit.customer_name_manual || null,
            visit.visit_purpose, visit.meeting_content, visit.deal_amount || null,
            visit.probability || null, visit.next_action || null, visit.next_action_date || null]);
        
        const visitId = db.exec('SELECT last_insert_rowid() as id')[0].values[0][0];
        
        // メーカー登録
        if (visit.manufacturer_ids && visit.manufacturer_ids.length > 0) {
          for (const mfrId of visit.manufacturer_ids) {
            db.run('INSERT INTO visit_manufacturers (visit_id, manufacturer_id) VALUES (?, ?)', [visitId, mfrId]);
          }
        }

        // 同行者登録
        if (visit.companion_ids && visit.companion_ids.length > 0) {
          for (const compId of visit.companion_ids) {
            db.run('INSERT INTO visit_companions (visit_id, user_id) VALUES (?, ?)', [visitId, compId]);
          }
        }
      }
    }

    // 提出時は上長・管理者に通知
    if (status === 'submitted') {
      const notifSettings = getNotificationSettings();
      const managersStmt = db.prepare(`SELECT id FROM users WHERE role IN ('manager', 'admin') AND id != ?`);
      managersStmt.bind([userId]);
      while (managersStmt.step()) {
        const manager = managersStmt.getAsObject();
        // アプリ内通知
        if (notifSettings.submitted_app) {
          db.run('INSERT INTO notifications (type, to_user_id, report_id) VALUES (?, ?, ?)',
            ['submitted', manager.id, reportId]);
        }
        // メール通知
        if (notifSettings.submitted_email) {
          sendNotificationEmail(manager.id, 'submitted', reportId);
        }
      }
      managersStmt.free();
    }
    
    saveDatabase();
    res.json({ success: true, id: reportId });
    
  } catch (error) {
    console.error('日報作成エラー:', error);
    res.status(500).json({ error: '日報の作成に失敗しました' });
  }
});

// 日報更新
app.put('/api/reports/:id', requireAuth, (req, res) => {
  const reportId = parseInt(req.params.id);
  const userId = req.session.user.id;
  
  // 自分の日報か確認
  const checkStmt = db.prepare('SELECT * FROM daily_reports WHERE id = ?');
  checkStmt.bind([reportId]);
  let report = null;
  if (checkStmt.step()) {
    report = checkStmt.getAsObject();
  }
  checkStmt.free();
  
  if (!report) {
    return res.status(404).json({ error: '日報が見つかりません' });
  }
  if (report.user_id !== userId) {
    return res.status(403).json({ error: '編集権限がありません' });
  }
  // 確認済みの日報は編集不可
  if (report.status === 'confirmed') {
    return res.status(403).json({ error: '確認済みの日報は編集できません' });
  }
  
  const {
    report_date,
    work_style,
    work_content,
    achievements,
    issues,
    consultation,
    status,
    tasks,
    visits
  } = req.body;
  
  try {
    db.run(`
      UPDATE daily_reports SET
        report_date = ?, work_style = ?, work_content = ?, achievements = ?,
        issues = ?, consultation = ?,
        status = ?, updated_at = datetime('now', '+9 hours')
      WHERE id = ?
    `, [report_date, work_style || null, work_content || null, achievements || null,
        issues || null, consultation || null,
        status || report.status, reportId]);
    
    // タスク更新
    db.run('DELETE FROM tasks WHERE report_id = ?', [reportId]);
    if (tasks && tasks.length > 0) {
      for (const task of tasks) {
        db.run('INSERT INTO tasks (report_id, content, is_completed, due_date) VALUES (?, ?, ?, ?)',
          [reportId, task.content, task.is_completed ? 1 : 0, task.due_date || null]);
      }
    }
    
    // 訪問更新
    db.run('DELETE FROM customer_visits WHERE report_id = ?', [reportId]);
    if (visits && visits.length > 0) {
      for (const visit of visits) {
        db.run(`
          INSERT INTO customer_visits 
          (report_id, visit_type, customer_id, supplier_id, customer_name_manual, visit_purpose, meeting_content, deal_amount, probability, next_action, next_action_date)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [reportId, visit.visit_type || 'customer', visit.customer_id || null, visit.supplier_id || null, visit.customer_name_manual || null,
            visit.visit_purpose, visit.meeting_content, visit.deal_amount || null,
            visit.probability || null, visit.next_action || null, visit.next_action_date || null]);
        
        const visitId = db.exec('SELECT last_insert_rowid() as id')[0].values[0][0];
        
        // メーカー登録
        if (visit.manufacturer_ids && visit.manufacturer_ids.length > 0) {
          for (const mfrId of visit.manufacturer_ids) {
            db.run('INSERT INTO visit_manufacturers (visit_id, manufacturer_id) VALUES (?, ?)', [visitId, mfrId]);
          }
        }

        // 同行者登録
        if (visit.companion_ids && visit.companion_ids.length > 0) {
          for (const compId of visit.companion_ids) {
            db.run('INSERT INTO visit_companions (visit_id, user_id) VALUES (?, ?)', [visitId, compId]);
          }
        }
      }
    }

    // 提出時は上長・管理者に通知（既存ステータスが提出済み以外の場合のみ）
    if (status === 'submitted' && report.status !== 'submitted') {
      const notifSettings = getNotificationSettings();
      const managersStmt = db.prepare(`SELECT id FROM users WHERE role IN ('manager', 'admin') AND id != ?`);
      managersStmt.bind([userId]);
      while (managersStmt.step()) {
        const manager = managersStmt.getAsObject();
        // アプリ内通知
        if (notifSettings.submitted_app) {
          db.run('INSERT INTO notifications (type, to_user_id, report_id) VALUES (?, ?, ?)',
            ['submitted', manager.id, reportId]);
        }
        // メール通知
        if (notifSettings.submitted_email) {
          sendNotificationEmail(manager.id, 'submitted', reportId);
        }
      }
      managersStmt.free();
    }
    
    saveDatabase();
    res.json({ success: true });
    
  } catch (error) {
    console.error('日報更新エラー:', error);
    res.status(500).json({ error: '日報の更新に失敗しました' });
  }
});

// 日報削除
app.delete('/api/reports/:id', requireAuth, (req, res) => {
  try {
    const reportId = req.params.id;
    const userId = req.session.user.id;
    const userRole = req.session.user.role;
    
    // 日報を取得
    const stmt = db.prepare('SELECT * FROM daily_reports WHERE id = ?');
    stmt.bind([reportId]);
    
    if (!stmt.step()) {
      stmt.free();
      return res.status(404).json({ error: '日報が見つかりません' });
    }
    
    const report = stmt.getAsObject();
    stmt.free();
    
    // 権限チェック: 自分の日報で確認済み以外、または管理者
    if (report.user_id !== userId && userRole !== 'admin') {
      return res.status(403).json({ error: '削除権限がありません' });
    }
    
    if (report.status === 'confirmed' && userRole !== 'admin') {
      return res.status(403).json({ error: '確認済みの日報は削除できません' });
    }
    
    // 関連データを削除
    // 訪問記録の関連テーブルを先に削除
    db.run(`DELETE FROM visit_companions WHERE visit_id IN (SELECT id FROM customer_visits WHERE report_id = ?)`, [reportId]);
    db.run(`DELETE FROM visit_manufacturers WHERE visit_id IN (SELECT id FROM customer_visits WHERE report_id = ?)`, [reportId]);
    db.run('DELETE FROM customer_visits WHERE report_id = ?', [reportId]);
    db.run('DELETE FROM tasks WHERE report_id = ?', [reportId]);
    db.run('DELETE FROM comments WHERE report_id = ?', [reportId]);
    db.run('DELETE FROM attachments WHERE report_id = ?', [reportId]);
    
    // 日報本体を削除
    db.run('DELETE FROM daily_reports WHERE id = ?', [reportId]);
    
    saveDatabase();
    res.json({ success: true, message: '日報を削除しました' });
    
  } catch (error) {
    console.error('日報削除エラー:', error);
    res.status(500).json({ error: '日報の削除に失敗しました' });
  }
});

// ============================================
// チーム日報API（上長・管理者用）
// ============================================

app.get('/api/team-reports', requireAuth, (req, res) => {
  // 全ユーザーが閲覧可能（確認・差し戻しは別APIで権限制御）

  const { status, from, to, department_id, user_id, customer_id, supplier_id, sort } = req.query;
  
  let query = `
    SELECT dr.*, u.name as user_name, d.name as department_name,
           cu.name as confirmed_by_name,
           (SELECT COUNT(*) FROM comments c WHERE c.report_id = dr.id) as comment_count
    FROM daily_reports dr
    JOIN users u ON dr.user_id = u.id
    LEFT JOIN departments d ON u.department_id = d.id
    LEFT JOIN users cu ON dr.confirmed_by = cu.id
    WHERE dr.status != 'draft'
  `;
  const params = [];
  
  if (status) {
    query += ' AND dr.status = ?';
    params.push(status);
  }
  if (from) {
    query += ' AND dr.report_date >= ?';
    params.push(from);
  }
  if (to) {
    query += ' AND dr.report_date <= ?';
    params.push(to);
  }
  if (department_id) {
    query += ' AND u.department_id = ?';
    params.push(parseInt(department_id));
  }
  if (user_id) {
    query += ' AND dr.user_id = ?';
    params.push(parseInt(user_id));
  }
  // 得意先フィルター
  if (customer_id) {
    query += ' AND EXISTS (SELECT 1 FROM customer_visits cv WHERE cv.report_id = dr.id AND cv.customer_id = ?)';
    params.push(parseInt(customer_id));
  }
  // 仕入先フィルター
  if (supplier_id) {
    query += ' AND EXISTS (SELECT 1 FROM customer_visits cv WHERE cv.report_id = dr.id AND cv.supplier_id = ?)';
    params.push(parseInt(supplier_id));
  }
  
  // ソート順
  if (sort === 'updated') {
    query += ' ORDER BY dr.updated_at DESC, dr.report_date DESC';
  } else {
    query += ' ORDER BY dr.report_date DESC, u.name';
  }
  
  // LIMIT解除（最大500件）
  query += ' LIMIT 500';
  
  const results = [];
  const stmt = db.prepare(query);
  if (params.length > 0) {
    stmt.bind(params);
  }
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();

  // 各日報の訪問先情報を取得
  for (const report of results) {
    const visitStmt = db.prepare(`
      SELECT cv.visit_type, cv.customer_id, cv.supplier_id, cv.customer_name_manual,
             c.name as customer_name, s.name as supplier_name
      FROM customer_visits cv
      LEFT JOIN customers c ON cv.customer_id = c.id
      LEFT JOIN suppliers s ON cv.supplier_id = s.id
      WHERE cv.report_id = ?
    `);
    visitStmt.bind([report.id]);
    const visitNames = [];
    const visitDetails = [];
    while (visitStmt.step()) {
      const v = visitStmt.getAsObject();
      const detail = {
        type: v.visit_type,
        customer_id: v.customer_id,
        supplier_id: v.supplier_id
      };
      if (v.visit_type === 'supplier' && v.supplier_name) {
        visitNames.push(v.supplier_name);
        detail.name = v.supplier_name;
      } else if (v.customer_name) {
        visitNames.push(v.customer_name);
        detail.name = v.customer_name;
      } else if (v.customer_name_manual) {
        visitNames.push(v.customer_name_manual);
        detail.name = v.customer_name_manual;
      }
      visitDetails.push(detail);
    }
    visitStmt.free();
    report.visit_names = visitNames.join(', ');
    report.visit_details = visitDetails;
    report.visit_count = visitNames.length;
  }

  res.json(results);
});

// ============================================
// エクスポートAPI
// ============================================

// 日報CSVエクスポート
app.get('/api/export/reports', requireAuth, (req, res) => {
  const { from, to, department_id, user_id } = req.query;

  let query = `
    SELECT dr.*, u.name as user_name, d.name as department_name,
           cu.name as confirmed_by_name
    FROM daily_reports dr
    JOIN users u ON dr.user_id = u.id
    LEFT JOIN departments d ON u.department_id = d.id
    LEFT JOIN users cu ON dr.confirmed_by = cu.id
    WHERE dr.status != 'draft'
  `;
  const params = [];

  if (from) {
    query += ' AND dr.report_date >= ?';
    params.push(from);
  }
  if (to) {
    query += ' AND dr.report_date <= ?';
    params.push(to);
  }
  if (department_id) {
    query += ' AND u.department_id = ?';
    params.push(parseInt(department_id));
  }
  if (user_id) {
    query += ' AND dr.user_id = ?';
    params.push(parseInt(user_id));
  }

  query += ' ORDER BY dr.report_date DESC, u.name';

  const reports = [];
  const stmt = db.prepare(query);
  if (params.length > 0) {
    stmt.bind(params);
  }
  while (stmt.step()) {
    reports.push(stmt.getAsObject());
  }
  stmt.free();

  // CSVヘッダー
  const headers = ['日付', '氏名', '部署', '勤務形態', 'ステータス', '確認者', '確認日時', '業務内容', '成果・進捗', '課題', '相談事項'];
  
  // CSV行
  const rows = reports.map(r => {
    const workStyleMap = { office: '出社', remote: 'リモート', outside: '外出' };
    const statusMap = { submitted: '提出済み', confirmed: '確認済み', rejected: '差し戻し' };
    return [
      r.report_date,
      r.user_name,
      r.department_name || '',
      workStyleMap[r.work_style] || '',
      statusMap[r.status] || '',
      r.confirmed_by_name || '',
      r.confirmed_at || '',
      (r.work_content || '').replace(/\n/g, ' '),
      (r.achievements || '').replace(/\n/g, ' '),
      (r.issues || '').replace(/\n/g, ' '),
      (r.consultation || '').replace(/\n/g, ' ')
    ];
  });

  // CSV生成
  const csvContent = [headers, ...rows]
    .map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
    .join('\n');

  // BOMを付けてUTF-8で出力（Excelで文字化けしないように）
  const bom = '\uFEFF';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="reports_${new Date().toISOString().slice(0,10)}.csv"`);
  res.send(bom + csvContent);
});

// 訪問履歴CSVエクスポート
app.get('/api/export/visits', requireAuth, (req, res) => {
  const { from, to, department_id, user_id } = req.query;

  let query = `
    SELECT cv.*, dr.report_date, u.name as user_name, d.name as department_name,
           c.name as customer_name, c.customer_code, s.name as supplier_name, s.supplier_code
    FROM customer_visits cv
    JOIN daily_reports dr ON cv.report_id = dr.id
    JOIN users u ON dr.user_id = u.id
    LEFT JOIN departments d ON u.department_id = d.id
    LEFT JOIN customers c ON cv.customer_id = c.id
    LEFT JOIN suppliers s ON cv.supplier_id = s.id
    WHERE dr.status != 'draft'
  `;
  const params = [];

  if (from) {
    query += ' AND dr.report_date >= ?';
    params.push(from);
  }
  if (to) {
    query += ' AND dr.report_date <= ?';
    params.push(to);
  }
  if (department_id) {
    query += ' AND u.department_id = ?';
    params.push(parseInt(department_id));
  }
  if (user_id) {
    query += ' AND dr.user_id = ?';
    params.push(parseInt(user_id));
  }

  query += ' ORDER BY dr.report_date DESC';

  const visits = [];
  const stmt = db.prepare(query);
  if (params.length > 0) {
    stmt.bind(params);
  }
  while (stmt.step()) {
    visits.push(stmt.getAsObject());
  }
  stmt.free();

  // 同行者情報を取得
  for (const visit of visits) {
    const compStmt = db.prepare(`
      SELECT u.name FROM users u
      JOIN visit_companions vc ON u.id = vc.user_id
      WHERE vc.visit_id = ?
    `);
    compStmt.bind([visit.id]);
    const companions = [];
    while (compStmt.step()) {
      companions.push(compStmt.getAsObject().name);
    }
    compStmt.free();
    visit.companion_names = companions.join('、');
  }

  // CSVヘッダー
  const headers = ['日付', '担当者', '部署', '訪問先種別', '訪問先コード', '訪問先名', '訪問目的', '商談内容', '金額', '確度', '同行者', '次回アクション', '次回日付'];
  
  // CSV行
  const rows = visits.map(v => {
    const visitType = v.visit_type === 'supplier' ? '仕入先' : '得意先';
    const visitCode = v.visit_type === 'supplier' ? (v.supplier_code || '') : (v.customer_code || '');
    const visitName = v.visit_type === 'supplier' ? (v.supplier_name || v.customer_name_manual || '') : (v.customer_name || v.customer_name_manual || '');
    return [
      v.report_date,
      v.user_name,
      v.department_name || '',
      visitType,
      visitCode,
      visitName,
      v.visit_purpose || '',
      (v.meeting_content || '').replace(/\n/g, ' '),
      v.deal_amount || '',
      v.probability || '',
      v.companion_names || '',
      v.next_action || '',
      v.next_action_date || ''
    ];
  });

  // CSV生成
  const csvContent = [headers, ...rows]
    .map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
    .join('\n');

  const bom = '\uFEFF';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="visits_${new Date().toISOString().slice(0,10)}.csv"`);
  res.send(bom + csvContent);
});

// 訪問履歴Excelエクスポート（強化版）
app.get('/api/export/visits-excel', requireAuth, (req, res) => {
  const { from, to, department_id, user_id, visit_type } = req.query;

  let query = `
    SELECT cv.*, dr.report_date, u.name as user_name, d.name as department_name,
           c.name as customer_name, c.customer_code, s.name as supplier_name, s.supplier_code
    FROM customer_visits cv
    JOIN daily_reports dr ON cv.report_id = dr.id
    JOIN users u ON dr.user_id = u.id
    LEFT JOIN departments d ON u.department_id = d.id
    LEFT JOIN customers c ON cv.customer_id = c.id
    LEFT JOIN suppliers s ON cv.supplier_id = s.id
    WHERE dr.status != 'draft'
  `;
  const params = [];

  if (from) {
    query += ' AND dr.report_date >= ?';
    params.push(from);
  }
  if (to) {
    query += ' AND dr.report_date <= ?';
    params.push(to);
  }
  if (department_id) {
    query += ' AND u.department_id = ?';
    params.push(parseInt(department_id));
  }
  if (user_id) {
    query += ' AND dr.user_id = ?';
    params.push(parseInt(user_id));
  }
  if (visit_type && visit_type !== 'all') {
    query += ' AND cv.visit_type = ?';
    params.push(visit_type);
  }

  query += ' ORDER BY dr.report_date DESC';

  const visits = [];
  const stmt = db.prepare(query);
  if (params.length > 0) {
    stmt.bind(params);
  }
  while (stmt.step()) {
    visits.push(stmt.getAsObject());
  }
  stmt.free();

  // 同行者とメーカー情報を取得
  for (const visit of visits) {
    // 同行者
    const compStmt = db.prepare(`
      SELECT u.name FROM users u
      JOIN visit_companions vc ON u.id = vc.user_id
      WHERE vc.visit_id = ?
    `);
    compStmt.bind([visit.id]);
    const companions = [];
    while (compStmt.step()) {
      companions.push(compStmt.getAsObject().name);
    }
    compStmt.free();
    visit.companion_names = companions.join('、');

    // メーカー
    const mfrStmt = db.prepare(`
      SELECT m.name FROM manufacturers m
      JOIN visit_manufacturers vm ON m.id = vm.manufacturer_id
      WHERE vm.visit_id = ?
    `);
    mfrStmt.bind([visit.id]);
    const manufacturers = [];
    while (mfrStmt.step()) {
      manufacturers.push(mfrStmt.getAsObject().name);
    }
    mfrStmt.free();
    visit.manufacturer_names = manufacturers.join('、');
  }

  // Excelデータ作成
  const data = visits.map(v => {
    const visitType = v.visit_type === 'supplier' ? '仕入先' : '得意先';
    const visitCode = v.visit_type === 'supplier' ? (v.supplier_code || '') : (v.customer_code || '');
    const visitName = v.visit_type === 'supplier' ? (v.supplier_name || v.customer_name_manual || '') : (v.customer_name || v.customer_name_manual || '');
    return {
      '日付': v.report_date,
      '担当者': v.user_name,
      '部署': v.department_name || '',
      '訪問先種別': visitType,
      '訪問先コード': visitCode,
      '訪問先名': visitName,
      '訪問目的': v.visit_purpose || '',
      '商談内容': v.meeting_content || '',
      'メーカー': v.manufacturer_names || '',
      '金額': v.deal_amount || '',
      '同行者': v.companion_names || '',
      '次回アクション': v.next_action || '',
      '次回日付': v.next_action_date || ''
    };
  });

  // ワークシート作成
  const ws = XLSX.utils.json_to_sheet(data);
  
  // 列幅設定
  ws['!cols'] = [
    { wch: 12 },  // 日付
    { wch: 10 },  // 担当者
    { wch: 12 },  // 部署
    { wch: 10 },  // 訪問先種別
    { wch: 12 },  // 訪問先コード
    { wch: 25 },  // 訪問先名
    { wch: 15 },  // 訪問目的
    { wch: 50 },  // 商談内容
    { wch: 20 },  // メーカー
    { wch: 12 },  // 金額
    { wch: 15 },  // 同行者
    { wch: 30 },  // 次回アクション
    { wch: 12 }   // 次回日付
  ];

  // ワークブック作成
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '訪問履歴');

  // バッファに書き出し
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="visits_${new Date().toISOString().slice(0,10)}.xlsx"`);
  res.send(buffer);
});

// ============================================
// コメントAPI
// ============================================

// コメント投稿
app.post('/api/reports/:id/comments', requireAuth, (req, res) => {
  const reportId = parseInt(req.params.id);
  const userId = req.session.user.id;
  const { content } = req.body;

  if (!content || !content.trim()) {
    return res.status(400).json({ error: 'コメント内容を入力してください' });
  }

  try {
    db.run('INSERT INTO comments (report_id, user_id, content) VALUES (?, ?, ?)',
      [reportId, userId, content.trim()]);

    // 通知対象者を収集（日報作成者 + 過去のコメント投稿者）
    const notifyUsers = new Set();

    // 日報作成者を追加
    const reportStmt = db.prepare('SELECT user_id FROM daily_reports WHERE id = ?');
    reportStmt.bind([reportId]);
    if (reportStmt.step()) {
      notifyUsers.add(reportStmt.getAsObject().user_id);
    }
    reportStmt.free();

    // 過去のコメント投稿者を追加
    const commentersStmt = db.prepare('SELECT DISTINCT user_id FROM comments WHERE report_id = ?');
    commentersStmt.bind([reportId]);
    while (commentersStmt.step()) {
      notifyUsers.add(commentersStmt.getAsObject().user_id);
    }
    commentersStmt.free();

    // 自分自身を除外して通知を作成
    const notifSettings = getNotificationSettings();
    notifyUsers.delete(userId);
    notifyUsers.forEach(toUserId => {
      // アプリ内通知
      if (notifSettings.comment_app) {
        db.run('INSERT INTO notifications (type, to_user_id, report_id) VALUES (?, ?, ?)',
          ['comment', toUserId, reportId]);
      }
      // メール通知
      if (notifSettings.comment_email) {
        sendNotificationEmail(toUserId, 'comment', reportId);
      }
    });

    saveDatabase();
    res.json({ success: true });
  } catch (error) {
    console.error('コメント投稿エラー:', error);
    res.status(500).json({ error: 'コメントの投稿に失敗しました' });
  }
});

// ============================================
// 確認・差し戻しAPI
// ============================================

// 確認済みにする（上長・管理者のみ）
app.post('/api/reports/:id/confirm', requireAuth, (req, res) => {
  const reportId = parseInt(req.params.id);
  const userId = req.session.user.id;
  const userRole = req.session.user.role;

  if (userRole !== 'manager' && userRole !== 'admin') {
    return res.status(403).json({ error: '権限がありません' });
  }

  try {
    // 日報作成者を取得
    const reportStmt = db.prepare('SELECT user_id FROM daily_reports WHERE id = ?');
    reportStmt.bind([reportId]);
    let reportOwnerId = null;
    if (reportStmt.step()) {
      reportOwnerId = reportStmt.getAsObject().user_id;
    }
    reportStmt.free();

    db.run(`UPDATE daily_reports SET status = 'confirmed', confirmed_by = ?, confirmed_at = datetime('now', '+9 hours') WHERE id = ?`,
      [userId, reportId]);
    saveDatabase();

    // 日報作成者にメール通知
    if (reportOwnerId) {
      const notifSettings = getNotificationSettings();
      if (notifSettings.confirmed_email) {
        sendNotificationEmail(reportOwnerId, 'confirmed', reportId);
      }
    }

    res.json({ success: true });
  } catch (error) {
    console.error('確認処理エラー:', error);
    res.status(500).json({ error: '処理に失敗しました' });
  }
});

// 差し戻し（上長・管理者のみ）
app.post('/api/reports/:id/reject', requireAuth, (req, res) => {
  const reportId = parseInt(req.params.id);
  const userId = req.session.user.id;
  const userRole = req.session.user.role;
  const { reason } = req.body;

  if (userRole !== 'manager' && userRole !== 'admin') {
    return res.status(403).json({ error: '権限がありません' });
  }

  try {
    db.run(`UPDATE daily_reports SET status = 'rejected' WHERE id = ?`, [reportId]);

    // 差し戻し理由をコメントとして追加
    if (reason && reason.trim()) {
      db.run('INSERT INTO comments (report_id, user_id, content) VALUES (?, ?, ?)',
        [reportId, userId, `【差し戻し】${reason.trim()}`]);
    }

    // 日報作成者への通知
    const notifSettings = getNotificationSettings();
    const reportStmt = db.prepare('SELECT user_id FROM daily_reports WHERE id = ?');
    reportStmt.bind([reportId]);
    if (reportStmt.step()) {
      const reportOwnerId = reportStmt.getAsObject().user_id;
      // アプリ内通知（差し戻しは常に通知）
      db.run('INSERT INTO notifications (type, to_user_id, report_id) VALUES (?, ?, ?)',
        ['rejected', reportOwnerId, reportId]);
      // メール通知
      if (notifSettings.rejected_email) {
        sendNotificationEmail(reportOwnerId, 'rejected', reportId);
      }
    }
    reportStmt.free();

    saveDatabase();
    res.json({ success: true });
  } catch (error) {
    console.error('差し戻し処理エラー:', error);
    res.status(500).json({ error: '処理に失敗しました' });
  }
});

// ============================================
// 通知API
// ============================================

// 未読通知取得
app.get('/api/notifications', requireAuth, (req, res) => {
  const userId = req.session.user.id;

  const results = [];
  const stmt = db.prepare(`
    SELECT n.*, dr.report_date, u.name as from_user_name
    FROM notifications n
    JOIN daily_reports dr ON n.report_id = dr.id
    LEFT JOIN (
      SELECT report_id, user_id FROM comments 
      GROUP BY report_id 
      ORDER BY created_at DESC
    ) c ON n.report_id = c.report_id AND n.type = 'comment'
    LEFT JOIN users u ON c.user_id = u.id
    WHERE n.to_user_id = ? AND n.sent_at > datetime('now', '-7 days')
    ORDER BY n.sent_at DESC
    LIMIT 20
  `);
  stmt.bind([userId]);
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();

  res.json(results);
});

// 通知を既読にする
app.delete('/api/notifications/:id', requireAuth, (req, res) => {
  const notifId = parseInt(req.params.id);
  const userId = req.session.user.id;

  db.run('DELETE FROM notifications WHERE id = ? AND to_user_id = ?', [notifId, userId]);
  saveDatabase();
  res.json({ success: true });
});

// 一括確認（上長・管理者のみ）
app.post('/api/reports/bulk-confirm', requireAuth, (req, res) => {
  const userId = req.session.user.id;
  const userRole = req.session.user.role;
  const { report_ids } = req.body;

  if (userRole !== 'manager' && userRole !== 'admin') {
    return res.status(403).json({ error: '権限がありません' });
  }

  if (!report_ids || !Array.isArray(report_ids) || report_ids.length === 0) {
    return res.status(400).json({ error: '確認する日報を選択してください' });
  }

  try {
    let confirmedCount = 0;
    for (const reportId of report_ids) {
      // 提出済みの日報のみ確認可能
      const checkStmt = db.prepare('SELECT status FROM daily_reports WHERE id = ?');
      checkStmt.bind([reportId]);
      if (checkStmt.step()) {
        const report = checkStmt.getAsObject();
        if (report.status === 'submitted') {
          db.run(`UPDATE daily_reports SET status = 'confirmed', confirmed_by = ?, confirmed_at = datetime('now', '+9 hours') WHERE id = ?`,
            [userId, reportId]);
          confirmedCount++;
        }
      }
      checkStmt.free();
    }

    saveDatabase();
    res.json({ success: true, confirmed_count: confirmedCount });
  } catch (error) {
    console.error('一括確認エラー:', error);
    res.status(500).json({ error: '処理に失敗しました' });
  }
});

// ============================================
// ファイル添付API
// ============================================

// ファイルアップロード
app.post('/api/reports/:id/attachments', requireAuth, upload.array('files', 5), (req, res) => {
  const reportId = parseInt(req.params.id);
  const userId = req.session.user.id;

  // 自分の日報か確認
  const checkStmt = db.prepare('SELECT user_id FROM daily_reports WHERE id = ?');
  checkStmt.bind([reportId]);
  let report = null;
  if (checkStmt.step()) {
    report = checkStmt.getAsObject();
  }
  checkStmt.free();

  if (!report || report.user_id !== userId) {
    // アップロードされたファイルを削除
    if (req.files) {
      req.files.forEach(f => fs.unlinkSync(f.path));
    }
    return res.status(403).json({ error: '権限がありません' });
  }

  try {
    const files = req.files || [];
    const inserted = [];

    for (const file of files) {
      db.run(`
        INSERT INTO attachments (report_id, original_name, stored_name, file_size, mime_type)
        VALUES (?, ?, ?, ?, ?)
      `, [reportId, file.originalname, file.filename, file.size, file.mimetype]);
      
      const id = db.exec('SELECT last_insert_rowid() as id')[0].values[0][0];
      inserted.push({
        id: id,
        original_name: file.originalname,
        file_size: file.size
      });
    }

    saveDatabase();
    res.json({ success: true, files: inserted });

  } catch (error) {
    console.error('ファイルアップロードエラー:', error);
    res.status(500).json({ error: 'ファイルのアップロードに失敗しました' });
  }
});

// 添付ファイル一覧取得
app.get('/api/reports/:id/attachments', requireAuth, (req, res) => {
  const reportId = parseInt(req.params.id);

  const results = [];
  const stmt = db.prepare('SELECT id, original_name, file_size, mime_type, created_at FROM attachments WHERE report_id = ?');
  stmt.bind([reportId]);
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  res.json(results);
});

// ファイルダウンロード
app.get('/api/attachments/:id/download', requireAuth, (req, res) => {
  const attachmentId = parseInt(req.params.id);

  const stmt = db.prepare('SELECT * FROM attachments WHERE id = ?');
  stmt.bind([attachmentId]);
  let attachment = null;
  if (stmt.step()) {
    attachment = stmt.getAsObject();
  }
  stmt.free();

  if (!attachment) {
    return res.status(404).json({ error: 'ファイルが見つかりません' });
  }

  const filePath = path.join(uploadDir, attachment.stored_name);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'ファイルが見つかりません' });
  }

  res.download(filePath, attachment.original_name);
});

// ファイルプレビュー（ブラウザで表示）
app.get('/api/attachments/:id/preview', requireAuth, (req, res) => {
  const attachmentId = parseInt(req.params.id);

  const stmt = db.prepare('SELECT * FROM attachments WHERE id = ?');
  stmt.bind([attachmentId]);
  let attachment = null;
  if (stmt.step()) {
    attachment = stmt.getAsObject();
  }
  stmt.free();

  if (!attachment) {
    return res.status(404).json({ error: 'ファイルが見つかりません' });
  }

  const filePath = path.join(uploadDir, attachment.stored_name);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'ファイルが見つかりません' });
  }

  // MIMEタイプを判定
  const ext = attachment.original_name.split('.').pop().toLowerCase();
  const mimeTypes = {
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'png': 'image/png',
    'gif': 'image/gif',
    'webp': 'image/webp',
    'pdf': 'application/pdf'
  };
  const mimeType = mimeTypes[ext] || 'application/octet-stream';

  res.setHeader('Content-Type', mimeType);
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(attachment.original_name)}"`);
  res.sendFile(filePath);
});

// ファイル削除
app.delete('/api/attachments/:id', requireAuth, (req, res) => {
  const attachmentId = parseInt(req.params.id);
  const userId = req.session.user.id;

  // ファイル情報と日報の所有者を確認
  const stmt = db.prepare(`
    SELECT a.*, dr.user_id 
    FROM attachments a 
    JOIN daily_reports dr ON a.report_id = dr.id 
    WHERE a.id = ?
  `);
  stmt.bind([attachmentId]);
  let attachment = null;
  if (stmt.step()) {
    attachment = stmt.getAsObject();
  }
  stmt.free();

  if (!attachment) {
    return res.status(404).json({ error: 'ファイルが見つかりません' });
  }

  if (attachment.user_id !== userId) {
    return res.status(403).json({ error: '権限がありません' });
  }

  try {
    // ファイル削除
    const filePath = path.join(uploadDir, attachment.stored_name);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    // DB削除
    db.run('DELETE FROM attachments WHERE id = ?', [attachmentId]);
    saveDatabase();

    res.json({ success: true });

  } catch (error) {
    console.error('ファイル削除エラー:', error);
    res.status(500).json({ error: 'ファイルの削除に失敗しました' });
  }
});

// ============================================
// HTMLページルーティング
// ============================================

app.get('/login.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'login.html'));
});

app.get('/', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'dashboard.html'));
});

app.get('/dashboard.html', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'dashboard.html'));
});

app.get('/report-new.html', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'report-new.html'));
});

app.get('/report-list.html', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'report-list.html'));
});

app.get('/report-detail.html', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'report-detail.html'));
});

app.get('/report-edit.html', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'report-edit.html'));
});

app.get('/team-reports.html', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'team-reports.html'));
});

app.get('/monthly-report.html', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'monthly-report.html'));
});

app.get('/admin-import.html', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'admin-import.html'));
});

app.get('/admin-users.html', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'admin-users.html'));
});

app.get('/admin-masters.html', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'admin-masters.html'));
});

app.get('/calendar.html', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'calendar.html'));
});

app.get('/search.html', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'search.html'));
});

app.get('/customer-history.html', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'customer-history.html'));
});

app.get('/weekly-report.html', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'weekly-report.html'));
});

app.get('/weekly-summary.html', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'weekly-summary.html'));
});

app.get('/unvisited-alerts.html', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'unvisited-alerts.html'));
});

app.get('/templates.html', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'templates.html'));
});

app.get('/stats.html', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'stats.html'));
});

app.get('/home.html', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'home.html'));
});

app.get('/admin-email.html', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'admin-email.html'));
});

app.get('/admin-notifications.html', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'admin-notifications.html'));
});

app.get('/admin-ai.html', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'admin-ai.html'));
});

app.get('/admin-sansan.html', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'admin-sansan.html'));
});

// ============================================
// 管理者用API（ユーザー・部署管理）
// ============================================

// 全ユーザー一覧（管理者用）
app.get('/api/admin/users', requireAuth, requireAdmin, (req, res) => {
  const results = [];
  const stmt = db.prepare(`
    SELECT u.id, u.login_id, u.name, u.email, u.department_id, u.role, d.name as department_name
    FROM users u
    LEFT JOIN departments d ON u.department_id = d.id
    ORDER BY d.name, u.name
  `);
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  res.json(results);
});

// ユーザー作成
app.post('/api/admin/users', requireAuth, requireAdmin, (req, res) => {
  const { login_id, password, name, email, department_id, role } = req.body;

  if (!login_id || !name || !role) {
    return res.status(400).json({ error: 'ログインID、氏名、権限は必須です' });
  }

  if (!password) {
    return res.status(400).json({ error: 'パスワードは必須です' });
  }

  // 重複チェック
  const existStmt = db.prepare('SELECT id FROM users WHERE login_id = ?');
  existStmt.bind([login_id]);
  if (existStmt.step()) {
    existStmt.free();
    return res.status(400).json({ error: 'このログインIDは既に使用されています' });
  }
  existStmt.free();

  const hash = bcrypt.hashSync(password, 10);
  db.run(
    'INSERT INTO users (login_id, password_hash, name, email, department_id, role) VALUES (?, ?, ?, ?, ?, ?)',
    [login_id, hash, name, email || null, department_id || null, role]
  );

  const id = db.exec('SELECT last_insert_rowid() as id')[0].values[0][0];
  saveDatabase();
  res.json({ id, message: 'ユーザーを作成しました' });
});

// ユーザー更新
app.put('/api/admin/users/:id', requireAuth, requireAdmin, (req, res) => {
  const { id } = req.params;
  const { login_id, password, name, email, department_id, role } = req.body;

  if (!login_id || !name || !role) {
    return res.status(400).json({ error: 'ログインID、氏名、権限は必須です' });
  }

  // 重複チェック（自分以外）
  const existStmt = db.prepare('SELECT id FROM users WHERE login_id = ? AND id != ?');
  existStmt.bind([login_id, parseInt(id)]);
  if (existStmt.step()) {
    existStmt.free();
    return res.status(400).json({ error: 'このログインIDは既に使用されています' });
  }
  existStmt.free();

  if (password) {
    const hash = bcrypt.hashSync(password, 10);
    db.run(
      "UPDATE users SET login_id = ?, password_hash = ?, name = ?, email = ?, department_id = ?, role = ?, updated_at = datetime('now', '+9 hours') WHERE id = ?",
      [login_id, hash, name, email || null, department_id || null, role, parseInt(id)]
    );
  } else {
    db.run(
      "UPDATE users SET login_id = ?, name = ?, email = ?, department_id = ?, role = ?, updated_at = datetime('now', '+9 hours') WHERE id = ?",
      [login_id, name, email || null, department_id || null, role, parseInt(id)]
    );
  }

  saveDatabase();
  res.json({ message: 'ユーザーを更新しました' });
});

// ユーザー削除
app.delete('/api/admin/users/:id', requireAuth, requireAdmin, (req, res) => {
  const { id } = req.params;

  // 自分自身は削除不可
  if (parseInt(id) === req.session.user.id) {
    return res.status(400).json({ error: '自分自身は削除できません' });
  }

  db.run('DELETE FROM users WHERE id = ?', [parseInt(id)]);
  saveDatabase();
  res.json({ message: 'ユーザーを削除しました' });
});

// 部署一覧（ユーザー数付き）
app.get('/api/departments', requireAuth, (req, res) => {
  const results = [];
  const stmt = db.prepare(`
    SELECT d.*, COUNT(u.id) as user_count
    FROM departments d
    LEFT JOIN users u ON d.id = u.department_id
    GROUP BY d.id
    ORDER BY d.name
  `);
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  res.json(results);
});

// 部署作成
app.post('/api/admin/departments', requireAuth, requireAdmin, (req, res) => {
  const { name } = req.body;

  if (!name) {
    return res.status(400).json({ error: '部署名は必須です' });
  }

  // 重複チェック
  const existStmt = db.prepare('SELECT id FROM departments WHERE name = ?');
  existStmt.bind([name]);
  if (existStmt.step()) {
    existStmt.free();
    return res.status(400).json({ error: 'この部署名は既に使用されています' });
  }
  existStmt.free();

  db.run('INSERT INTO departments (name) VALUES (?)', [name]);
  const id = db.exec('SELECT last_insert_rowid() as id')[0].values[0][0];
  saveDatabase();
  res.json({ id, message: '部署を作成しました' });
});

// 部署更新
app.put('/api/admin/departments/:id', requireAuth, requireAdmin, (req, res) => {
  const { id } = req.params;
  const { name } = req.body;

  if (!name) {
    return res.status(400).json({ error: '部署名は必須です' });
  }

  // 重複チェック（自分以外）
  const existStmt = db.prepare('SELECT id FROM departments WHERE name = ? AND id != ?');
  existStmt.bind([name, parseInt(id)]);
  if (existStmt.step()) {
    existStmt.free();
    return res.status(400).json({ error: 'この部署名は既に使用されています' });
  }
  existStmt.free();

  db.run('UPDATE departments SET name = ? WHERE id = ?', [name, parseInt(id)]);
  saveDatabase();
  res.json({ message: '部署を更新しました' });
});

// 部署削除
app.delete('/api/admin/departments/:id', requireAuth, requireAdmin, (req, res) => {
  const { id } = req.params;

  // 所属ユーザーチェック
  const countStmt = db.prepare('SELECT COUNT(*) as count FROM users WHERE department_id = ?');
  countStmt.bind([parseInt(id)]);
  countStmt.step();
  const count = countStmt.getAsObject().count;
  countStmt.free();

  if (count > 0) {
    return res.status(400).json({ error: `この部署には${count}名のユーザーが所属しています` });
  }

  db.run('DELETE FROM departments WHERE id = ?', [parseInt(id)]);
  saveDatabase();
  res.json({ message: '部署を削除しました' });
});

// ============================================
// マスター管理API（管理者専用）
// ============================================

// 得意先一覧（全件）
app.get('/api/masters/customers', requireAuth, requireAdmin, (req, res) => {
  const results = [];
  const stmt = db.prepare(`
    SELECT c.*, u.name as assigned_user_name 
    FROM customers c
    LEFT JOIN users u ON c.assigned_user_id = u.id
    ORDER BY c.customer_code
  `);
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  res.json(results);
});

// 得意先作成
app.post('/api/masters/customers', requireAuth, requireAdmin, (req, res) => {
  const { customer_code, name, assigned_user_id, address1, phone } = req.body;
  
  if (!customer_code || !name) {
    return res.status(400).json({ error: 'コードと名前は必須です' });
  }

  // 重複チェック
  const checkStmt = db.prepare('SELECT id FROM customers WHERE customer_code = ?');
  checkStmt.bind([customer_code]);
  if (checkStmt.step()) {
    checkStmt.free();
    return res.status(400).json({ error: 'このコードは既に使用されています' });
  }
  checkStmt.free();

  db.run('INSERT INTO customers (customer_code, name, assigned_user_id, address1, phone) VALUES (?, ?, ?, ?, ?)',
    [customer_code, name, assigned_user_id || null, address1 || '', phone || '']);
  saveDatabase();
  res.json({ success: true });
});

// 得意先更新
app.put('/api/masters/customers/:id', requireAuth, requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const { customer_code, name, assigned_user_id, address1, phone } = req.body;
  
  if (!customer_code || !name) {
    return res.status(400).json({ error: 'コードと名前は必須です' });
  }

  db.run('UPDATE customers SET customer_code = ?, name = ?, assigned_user_id = ?, address1 = ?, phone = ?, updated_at = datetime("now", "+9 hours") WHERE id = ?',
    [customer_code, name, assigned_user_id || null, address1 || '', phone || '', id]);
  saveDatabase();
  res.json({ success: true });
});

// 得意先削除
app.delete('/api/masters/customers/:id', requireAuth, requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  db.run('DELETE FROM customers WHERE id = ?', [id]);
  saveDatabase();
  res.json({ success: true });
});

// 仕入先一覧（全件）
app.get('/api/masters/suppliers', requireAuth, requireAdmin, (req, res) => {
  const results = [];
  const stmt = db.prepare('SELECT * FROM suppliers ORDER BY supplier_code');
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  res.json(results);
});

// 仕入先作成
app.post('/api/masters/suppliers', requireAuth, requireAdmin, (req, res) => {
  const { supplier_code, name, address1, phone } = req.body;
  
  if (!supplier_code || !name) {
    return res.status(400).json({ error: 'コードと名前は必須です' });
  }

  // 重複チェック
  const checkStmt = db.prepare('SELECT id FROM suppliers WHERE supplier_code = ?');
  checkStmt.bind([supplier_code]);
  if (checkStmt.step()) {
    checkStmt.free();
    return res.status(400).json({ error: 'このコードは既に使用されています' });
  }
  checkStmt.free();

  db.run('INSERT INTO suppliers (supplier_code, name, address1, phone) VALUES (?, ?, ?, ?)',
    [supplier_code, name, address1 || '', phone || '']);
  saveDatabase();
  res.json({ success: true });
});

// 仕入先更新
app.put('/api/masters/suppliers/:id', requireAuth, requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const { supplier_code, name, address1, phone } = req.body;
  
  if (!supplier_code || !name) {
    return res.status(400).json({ error: 'コードと名前は必須です' });
  }

  db.run('UPDATE suppliers SET supplier_code = ?, name = ?, address1 = ?, phone = ?, updated_at = datetime("now", "+9 hours") WHERE id = ?',
    [supplier_code, name, address1 || '', phone || '', id]);
  saveDatabase();
  res.json({ success: true });
});

// 仕入先削除
app.delete('/api/masters/suppliers/:id', requireAuth, requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  db.run('DELETE FROM suppliers WHERE id = ?', [id]);
  saveDatabase();
  res.json({ success: true });
});

// メーカー一覧（全件）
app.get('/api/masters/manufacturers', requireAuth, requireAdmin, (req, res) => {
  const results = [];
  const stmt = db.prepare('SELECT * FROM manufacturers ORDER BY name');
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  res.json(results);
});

// メーカー作成
app.post('/api/masters/manufacturers', requireAuth, requireAdmin, (req, res) => {
  const { name } = req.body;
  
  if (!name) {
    return res.status(400).json({ error: 'メーカー名は必須です' });
  }

  db.run('INSERT INTO manufacturers (name) VALUES (?)', [name]);
  saveDatabase();
  res.json({ success: true });
});

// メーカー更新
app.put('/api/masters/manufacturers/:id', requireAuth, requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const { name } = req.body;
  
  if (!name) {
    return res.status(400).json({ error: 'メーカー名は必須です' });
  }

  db.run('UPDATE manufacturers SET name = ? WHERE id = ?', [name, id]);
  saveDatabase();
  res.json({ success: true });
});

// メーカー削除
app.delete('/api/masters/manufacturers/:id', requireAuth, requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  db.run('DELETE FROM manufacturers WHERE id = ?', [id]);
  saveDatabase();
  res.json({ success: true });
});

// ============================================
// AI設定・日報生成API
// ============================================

// AI設定取得
app.get('/api/ai-settings', requireAuth, requireAdmin, (req, res) => {
  try {
    const stmt = db.prepare('SELECT * FROM ai_settings WHERE id = 1');
    if (stmt.step()) {
      const settings = stmt.getAsObject();
      // APIキーはマスクして返す
      if (settings.api_key) {
        settings.api_key_masked = settings.api_key.substring(0, 10) + '...' + settings.api_key.substring(settings.api_key.length - 4);
        settings.has_api_key = true;
      } else {
        settings.has_api_key = false;
      }
      delete settings.api_key; // 生のAPIキーは返さない
      stmt.free();
      res.json(settings);
    } else {
      stmt.free();
      res.json({ enabled: 0, has_api_key: false });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// AI設定更新
app.post('/api/ai-settings', requireAuth, requireAdmin, (req, res) => {
  try {
    const { api_key, model, enabled, custom_prompt } = req.body;
    
    // テーブル存在確認・作成
    db.run(`
      CREATE TABLE IF NOT EXISTS ai_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        api_key TEXT,
        model TEXT DEFAULT 'claude-3-5-haiku-20241022',
        enabled INTEGER DEFAULT 0,
        custom_prompt TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    const existsStmt = db.prepare('SELECT id FROM ai_settings WHERE id = 1');
    const exists = existsStmt.step();
    existsStmt.free();
    
    if (exists) {
      // APIキーが指定された場合のみ更新
      if (api_key) {
        db.run('UPDATE ai_settings SET api_key = ?, model = ?, enabled = ?, custom_prompt = ?, updated_at = datetime("now", "+9 hours") WHERE id = 1',
          [api_key, model || 'claude-3-5-haiku-20241022', enabled ? 1 : 0, custom_prompt || '']);
      } else {
        db.run('UPDATE ai_settings SET model = ?, enabled = ?, custom_prompt = ?, updated_at = datetime("now", "+9 hours") WHERE id = 1',
          [model || 'claude-3-5-haiku-20241022', enabled ? 1 : 0, custom_prompt || '']);
      }
    } else {
      db.run('INSERT INTO ai_settings (id, api_key, model, enabled, custom_prompt) VALUES (1, ?, ?, ?, ?)',
        [api_key || '', model || 'claude-3-5-haiku-20241022', enabled ? 1 : 0, custom_prompt || '']);
    }
    
    saveDatabase();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// AI日報生成（メモから日報テキストを生成）
app.post('/api/ai/generate-report', requireAuth, async (req, res) => {
  try {
    const { memo, visits } = req.body;
    
    if (!memo && (!visits || visits.length === 0)) {
      return res.status(400).json({ error: 'メモまたは訪問情報を入力してください' });
    }
    
    // AI設定を取得
    const settingsStmt = db.prepare('SELECT * FROM ai_settings WHERE id = 1');
    let settings = null;
    if (settingsStmt.step()) {
      settings = settingsStmt.getAsObject();
    }
    settingsStmt.free();
    
    if (!settings || !settings.enabled || !settings.api_key) {
      return res.status(400).json({ error: 'AI機能が有効になっていません。管理者にお問い合わせください。' });
    }
    
    // 訪問情報をテキスト化
    let visitsText = '';
    if (visits && visits.length > 0) {
      visitsText = '\n\n【訪問情報】\n' + visits.map((v, i) => 
        `${i + 1}. ${v.target_name || '（訪問先未入力）'}\n   メモ: ${v.memo || '（なし）'}`
      ).join('\n');
    }
    
    // プロンプト構築（カスタムプロンプトがある場合はそちらを使用）
    const baseSystemPrompt = `あなたは電子部品商社の営業日報作成を支援するアシスタントです。
営業担当者のメモから訪問先（会社名）と同行者を抽出し、詳細な商談内容を整理してJSONで出力してください。

【タスク】
1. メモの中から「訪問した会社」「商談した会社」を見つける
2. 各会社について、メモに書かれた内容を詳しく整理する
3. 同行者がいれば抽出する（「○○部長と」「○○課長と」「○○と同行」など）
4. JSON形式で出力する

【JSON形式】必ずこの形式で出力してください：
{"extracted_visits":[{"company_name":"会社名","memo":"商談内容","companions":["同行者名"]}]}

【会社名の抽出ルール】
- 「〇〇電機」「〇〇電気」「〇〇工業」「〇〇産業」「〇〇商事」などは会社名
- 「〇〇様」「〇〇さん」の「〇〇」が会社名の可能性が高い
- 「訪問」「商談」「打合せ」「ヒアリング」の対象が会社名
- 「株式会社」「（株）」「㈱」は除去してシンプルな名前にする

【同行者の抽出ルール】
- 「○○部長と」「○○課長と同行」などの○○は同行者
- 役職は除去して名前だけ抽出（「岡村部長」→「岡村」）
- 自社社員の名前のみ抽出（相手先の担当者名は含めない）

【商談内容（memo）の書き方 - 重要】
★ メモの情報量に応じて文章量を調整してください
★ 箇条書きのメモは、すべての項目を文章化して含めてください
★ 具体的な数字、製品名、担当者名、課題、今後の予定などがあれば必ず含めてください
★ 「〜しました。」「〜の予定です。」「〜とのことです。」のように敬体で書いてください
★ メモにない事実は追加しないでください

【文章量の目安】
- メモが短い（1〜2項目）→ 1〜2文で簡潔に
- メモが中程度（3〜5項目）→ 3〜5文で詳しく
- メモが長い（6項目以上）→ すべての情報を網羅して詳細に記述

【出力例】
入力: 「滝沢電機　新規ヒアリング　コンデンサ見積依頼」
出力: {"extracted_visits":[{"company_name":"滝沢電機","memo":"新規案件のヒアリングを実施しました。コンデンサの見積依頼をいただきました。","companions":[]}]}

入力: 「ミスミ訪問　岡村部長と同行　小林様面談　ミスミブランド窓口拡大　正規メーカーと別管理で販売　ナイロンコネクタ中心　20-30%確保目標　サトーパーツは非在庫からスタート　AWG0袋入れ課題　イワセAWG0サンプル希望　年間3500万10%ダウン見込み　価格納期MOQ確認要　最終判断は甲村様」
出力: {"extracted_visits":[{"company_name":"ミスミ","memo":"小林様と面談いたしました。ミスミブランドについて、窓口拡大を目的として正規メーカーとミスミブランドを別管理で販売する方針を検討しました。小林様はナイロンコネクタを中心にご担当されており、ミスミとして最低20〜30%の確保を目標とされています。サトーパーツに関しては現状非在庫製品からのスタートとなります。AWG0サイズについて袋入れの課題があり、イワセのAWG0サンプルの確認を希望されています。年間購入予定は3500万円で10%ダウンの見込みがあるとのことです。価格、納期、MOQ、オペレーションについて検討いただき、現担当者への確認が必要で、最終判断は甲村様が行います。","companions":["岡村"]}]}

【重要】
- 必ずJSON形式のみを出力（説明文は不要）
- 会社名が1つも見つからない場合は {"extracted_visits":[]} を出力
- companionsは配列（同行者がいない場合は空配列[]）
- メモの情報を省略せず、すべて商談内容に含めてください`;

    const systemPrompt = settings.custom_prompt || baseSystemPrompt;

    const userPrompt = `以下のメモから訪問先（会社名）を抽出し、メモの内容をすべて含めた詳細な商談内容を作成してください。

${memo || ''}
${visitsText}

JSON形式で出力:`;

    // Claude API呼び出し
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': settings.api_key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: settings.model || 'claude-3-5-haiku-20241022',
        max_tokens: 1024,
        messages: [
          { role: 'user', content: userPrompt }
        ],
        system: systemPrompt
      })
    });
    
    if (!response.ok) {
      const errorData = await response.json();
      console.error('Claude API エラー:', errorData);
      return res.status(500).json({ error: 'AI生成に失敗しました: ' + (errorData.error?.message || 'Unknown error') });
    }
    
    const data = await response.json();
    const generatedText = data.content[0]?.text || '';
    
    console.log('AI生成結果:', generatedText);
    
    // JSONをパース
    let extracted_visits = [];
    
    try {
      // JSONブロックを抽出（```json ... ``` または { ... }）
      let jsonStr = generatedText;
      const jsonMatch = generatedText.match(/```json\s*([\s\S]*?)\s*```/) || 
                        generatedText.match(/(\{[\s\S]*\})/);
      if (jsonMatch) {
        jsonStr = jsonMatch[1];
      }
      console.log('パース対象JSON:', jsonStr);
      const parsed = JSON.parse(jsonStr);
      extracted_visits = Array.isArray(parsed.extracted_visits) ? parsed.extracted_visits : [];
      console.log('抽出された訪問先:', extracted_visits);
    } catch (parseError) {
      console.log('JSON parse failed:', parseError.message);
      console.log('生テキスト:', generatedText);
    }
    
    // 訪問先が抽出できなかった場合のフォールバック
    // メモから直接会社名らしきものを抽出する
    if (extracted_visits.length === 0 && memo) {
      console.log('フォールバック抽出開始:', memo);
      const lines = memo.split('\n');
      for (const line of lines) {
        const trimmedLine = line.trim();
        if (!trimmedLine) continue;
        
        // 「・」「-」「*」「・」で始まる行、または単純に会社名っぽい行を抽出
        let companyName = '';
        let memoText = trimmedLine;
        
        // パターン1: 「・滝沢電機　〜」のような形式
        const pattern1 = trimmedLine.match(/^[・\-\*・]\s*([^\s　、。]+)/);
        if (pattern1) {
          companyName = pattern1[1];
          memoText = trimmedLine.replace(/^[・\-\*・]\s*/, '');
        }
        
        // パターン2: 行頭が会社名っぽい（カタカナ・漢字で始まり、空白や「　」で区切られる）
        if (!companyName) {
          const pattern2 = trimmedLine.match(/^([ァ-ヶー一-龥]+(?:電機|電気|電子|工業|産業|商事|物産|製作所|工場|株式会社|（株）)?)\s*[　\s]/);
          if (pattern2) {
            companyName = pattern2[1];
          }
        }
        
        if (companyName && companyName.length >= 2) {
          // 「様」「（株）」などを除去
          companyName = companyName.replace(/[様]$/g, '').replace(/^(株式会社|（株）|㈱)/g, '').replace(/(株式会社|（株）|㈱)$/g, '');
          
          extracted_visits.push({
            company_name: companyName,
            memo: memoText
          });
        }
      }
      console.log('フォールバック抽出結果:', extracted_visits);
    }
    
    // 抽出した訪問先を顧客・仕入先マスターとマッチング
    const matchedVisits = [];
    for (const visit of extracted_visits) {
      const companyName = visit.company_name || '';
      if (!companyName) continue;
      
      // 正規化した会社名
      const normalizedCompanyName = normalizeString(companyName);
      
      // 顧客マスターから検索（正規化比較）
      const customerMatches = [];
      const custStmt = db.prepare(`SELECT id, customer_code, name, 'customer' as type FROM customers`);
      while (custStmt.step()) {
        const cust = custStmt.getAsObject();
        const normalizedCustName = normalizeString(cust.name);
        // 正規化後の部分一致
        if (normalizedCustName.includes(normalizedCompanyName) || normalizedCompanyName.includes(normalizedCustName)) {
          // 完全一致を先頭に
          const exactMatch = normalizedCustName === normalizedCompanyName;
          customerMatches.push({ ...cust, exactMatch });
        }
      }
      custStmt.free();
      // 完全一致を優先、その後は名前の短い順
      customerMatches.sort((a, b) => {
        if (a.exactMatch && !b.exactMatch) return -1;
        if (!a.exactMatch && b.exactMatch) return 1;
        return a.name.length - b.name.length;
      });
      
      // 仕入先マスターから検索（正規化比較）
      const supplierMatches = [];
      const suppStmt = db.prepare(`SELECT id, supplier_code, name, 'supplier' as type FROM suppliers`);
      while (suppStmt.step()) {
        const supp = suppStmt.getAsObject();
        const normalizedSuppName = normalizeString(supp.name);
        if (normalizedSuppName.includes(normalizedCompanyName) || normalizedCompanyName.includes(normalizedSuppName)) {
          const exactMatch = normalizedSuppName === normalizedCompanyName;
          supplierMatches.push({ ...supp, exactMatch });
        }
      }
      suppStmt.free();
      supplierMatches.sort((a, b) => {
        if (a.exactMatch && !b.exactMatch) return -1;
        if (!a.exactMatch && b.exactMatch) return 1;
        return a.name.length - b.name.length;
      });
      
      // 同行者をユーザーマスターとマッチング
      const companionMatches = [];
      if (visit.companions && Array.isArray(visit.companions)) {
        for (const companionName of visit.companions) {
          if (!companionName) continue;
          // 苗字で検索（同姓がいないことを想定）
          const userStmt = db.prepare(`SELECT id, name FROM users WHERE name LIKE ?`);
          userStmt.bind([companionName + '%']);
          if (userStmt.step()) {
            companionMatches.push(userStmt.getAsObject());
          }
          userStmt.free();
        }
      }
      
      matchedVisits.push({
        original_name: companyName,
        memo: visit.memo || '',
        customer_matches: customerMatches.slice(0, 5),
        supplier_matches: supplierMatches.slice(0, 5),
        companion_matches: companionMatches
      });
    }
    
    res.json({ 
      success: true, 
      extracted_visits: matchedVisits
    });
    
  } catch (error) {
    console.error('AI生成エラー:', error);
    res.status(500).json({ error: 'AI生成に失敗しました: ' + error.message });
  }
});

// AI経由での新規顧客登録（管理者通知付き）
app.post('/api/ai/register-new-customer', requireAuth, async (req, res) => {
  try {
    const { name } = req.body;
    const userId = req.session.user.id;
    const userName = req.session.user.name;
    
    if (!name) {
      return res.status(400).json({ error: '顧客名は必須です' });
    }
    
    // 顧客マスターに登録
    db.run('INSERT INTO customers (name, created_at) VALUES (?, datetime("now", "+9 hours"))', [name]);
    
    // 登録したIDを取得
    const customerId = db.exec('SELECT last_insert_rowid() as id')[0].values[0][0];
    
    saveDatabase();
    
    // 管理者にメール通知
    try {
      // メール設定を取得
      const emailStmt = db.prepare('SELECT * FROM email_settings WHERE id = 1');
      let emailSettings = null;
      if (emailStmt.step()) {
        emailSettings = emailStmt.getAsObject();
      }
      emailStmt.free();
      
      if (emailSettings && emailSettings.smtp_host) {
        // 管理者のメールアドレスを取得
        const adminEmails = [];
        const adminStmt = db.prepare("SELECT email FROM users WHERE role = 'admin' AND email IS NOT NULL AND email != ''");
        while (adminStmt.step()) {
          adminEmails.push(adminStmt.getAsObject().email);
        }
        adminStmt.free();
        
        if (adminEmails.length > 0) {
          const nodemailer = require('nodemailer');
          const transporter = nodemailer.createTransport({
            host: emailSettings.smtp_host,
            port: emailSettings.smtp_port || 587,
            secure: emailSettings.smtp_secure === 1,
            auth: emailSettings.smtp_user ? {
              user: emailSettings.smtp_user,
              pass: emailSettings.smtp_password
            } : undefined
          });
          
          const mailOptions = {
            from: emailSettings.from_address || emailSettings.smtp_user,
            to: adminEmails.join(', '),
            subject: '【日報システム】新規顧客が登録されました',
            text: `新規顧客が登録されました。

■ 登録者: ${userName}
■ 顧客名: ${name}
■ 登録日時: ${new Date().toLocaleString('ja-JP')}

※ この顧客は日報作成時にAI機能から登録されました。
※ 必要に応じてマスター管理画面で詳細情報を追加してください。

---
営業日報システム`
          };
          
          await transporter.sendMail(mailOptions);
          console.log('新規顧客登録通知メールを送信しました:', name);
        }
      }
    } catch (emailError) {
      console.error('通知メール送信エラー:', emailError);
      // メール送信失敗しても顧客登録は成功とする
    }
    
    res.json({ 
      success: true, 
      customer_id: customerId,
      message: `顧客「${name}」を登録しました`
    });
    
  } catch (error) {
    console.error('新規顧客登録エラー:', error);
    res.status(500).json({ error: '顧客登録に失敗しました: ' + error.message });
  }
});

// AI訪問内容生成（個別の訪問メモから詳細を生成）
app.post('/api/ai/generate-visit', requireAuth, async (req, res) => {
  try {
    const { target_name, memo } = req.body;
    
    if (!memo) {
      return res.status(400).json({ error: 'メモを入力してください' });
    }
    
    // AI設定を取得
    const settingsStmt = db.prepare('SELECT * FROM ai_settings WHERE id = 1');
    let settings = null;
    if (settingsStmt.step()) {
      settings = settingsStmt.getAsObject();
    }
    settingsStmt.free();
    
    if (!settings || !settings.enabled || !settings.api_key) {
      return res.status(400).json({ error: 'AI機能が有効になっていません' });
    }
    
    const systemPrompt = `あなたは営業日報の作成を支援するアシスタントです。
訪問先でのやり取りのメモから、簡潔な訪問報告文を作成してください。

【出力ルール】
- 敬体（です・ます調）
- 100-150文字程度で簡潔に
- 推測で内容を追加しない
- 次のアクションがあれば含める`;

    const userPrompt = `訪問先: ${target_name || '（不明）'}

メモ: ${memo}

上記のメモから訪問報告の文章を作成してください。`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': settings.api_key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: settings.model || 'claude-3-5-haiku-20241022',
        max_tokens: 512,
        messages: [
          { role: 'user', content: userPrompt }
        ],
        system: systemPrompt
      })
    });
    
    if (!response.ok) {
      const errorData = await response.json();
      return res.status(500).json({ error: 'AI生成に失敗しました' });
    }
    
    const data = await response.json();
    const generatedText = data.content[0]?.text || '';
    
    res.json({ 
      success: true, 
      generated: generatedText
    });
    
  } catch (error) {
    console.error('AI生成エラー:', error);
    res.status(500).json({ error: 'AI生成に失敗しました: ' + error.message });
  }
});

// AI機能が有効かどうかのチェック（一般ユーザー向け）
app.get('/api/ai/status', requireAuth, (req, res) => {
  try {
    const stmt = db.prepare('SELECT enabled FROM ai_settings WHERE id = 1');
    let enabled = false;
    if (stmt.step()) {
      enabled = stmt.getAsObject().enabled === 1;
    }
    stmt.free();
    res.json({ enabled });
  } catch (error) {
    res.json({ enabled: false });
  }
});

// ============================================
// インポートAPI（管理者専用）
// ============================================

// CSVパース関数
function parseCSV(text) {
  // BOM除去
  if (text.charCodeAt(0) === 0xFEFF) {
    text = text.slice(1);
  }
  
  const lines = text.split('\n').filter(l => l.trim());
  if (lines.length < 2) return { headers: [], rows: [] };

  const parseCSVLine = (line) => {
    const result = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        result.push(current.trim());
        current = '';
      } else if (char !== '\r') {
        current += char;
      }
    }
    result.push(current.trim());
    return result;
  };

  const headers = parseCSVLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i]);
    // 列数が1以上あれば処理
    if (cols.length > 0 && cols.some(c => c)) {
      const row = {};
      headers.forEach((h, idx) => {
        row[h] = cols[idx] || '';
      });
      rows.push(row);
    }
  }
  return { headers, rows };
}

// ユーザーインポート
app.post('/api/import/users', requireAuth, requireAdmin, upload.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'ファイルがありません' });
    }

    const text = readCSVFile(req.file.path);
    const { rows } = parseCSV(text);

    let inserted = 0;
    let updated = 0;

    for (const row of rows) {
      const loginId = row.login_id;
      const password = row.password;
      const name = row.name;
      const role = row.role || 'sales';
      const deptName = row.department_name;

      if (!loginId || !name) continue;

      // 部署ID取得（なければ作成）
      let deptId = null;
      if (deptName) {
        const deptStmt = db.prepare('SELECT id FROM departments WHERE name = ?');
        deptStmt.bind([deptName]);
        if (deptStmt.step()) {
          deptId = deptStmt.getAsObject().id;
        } else {
          db.run('INSERT INTO departments (name) VALUES (?)', [deptName]);
          deptId = db.exec('SELECT last_insert_rowid() as id')[0].values[0][0];
        }
        deptStmt.free();
      }

      // 既存チェック
      const existStmt = db.prepare('SELECT id FROM users WHERE login_id = ?');
      existStmt.bind([loginId]);
      const exists = existStmt.step();
      const existingId = exists ? existStmt.getAsObject().id : null;
      existStmt.free();

      if (exists) {
        // 更新（パスワードが空なら更新しない）
        if (password) {
          const hash = bcrypt.hashSync(password, 10);
          db.run('UPDATE users SET name = ?, role = ?, department_id = ?, password_hash = ? WHERE id = ?',
            [name, role, deptId, hash, existingId]);
        } else {
          db.run('UPDATE users SET name = ?, role = ?, department_id = ? WHERE id = ?',
            [name, role, deptId, existingId]);
        }
        updated++;
      } else {
        // 新規
        const hash = bcrypt.hashSync(password || 'password123', 10);
        db.run('INSERT INTO users (login_id, password_hash, name, role, department_id) VALUES (?, ?, ?, ?, ?)',
          [loginId, hash, name, role, deptId]);
        inserted++;
      }
    }

    saveDatabase();
    fs.unlinkSync(req.file.path);
    res.json({ inserted, updated });

  } catch (error) {
    console.error('ユーザーインポートエラー:', error);
    res.status(500).json({ error: error.message });
  }
});

// 得意先インポート
app.post('/api/import/customers', requireAuth, requireAdmin, upload.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'ファイルがありません' });
    }

    const text = readCSVFile(req.file.path);
    const { rows } = parseCSV(text);

    // ユーザーマッピング（login_id -> user_id）を作成
    const userMap = {};
    const userStmt = db.prepare('SELECT id, login_id FROM users');
    while (userStmt.step()) {
      const u = userStmt.getAsObject();
      userMap[u.login_id] = u.id;
    }
    userStmt.free();

    let inserted = 0;
    let updated = 0;

    for (const row of rows) {
      // 基幹システム形式: 得意先コード,得意先名,担当者コード,担当者名
      // または従来形式: customer_code,name,...
      const code = row['得意先コード'] || row.customer_code;
      const name = row['得意先名'] || row.name;
      const salesRepCode = row['担当者コード'] || row.sales_rep_code || '';
      const salesRepName = row['担当者名'] || row.sales_rep_name || '';
      const address1 = row.address1 || '';
      const address2 = row.address2 || '';
      const phone = row.phone || '';

      if (!code || !name) continue;

      // 担当者コードからユーザーIDを取得
      const assignedUserId = salesRepCode ? (userMap[salesRepCode] || null) : null;

      // 既存チェック
      const existStmt = db.prepare('SELECT id FROM customers WHERE customer_code = ?');
      existStmt.bind([code]);
      const exists = existStmt.step();
      const existingId = exists ? existStmt.getAsObject().id : null;
      existStmt.free();

      if (exists) {
        db.run('UPDATE customers SET name = ?, address1 = ?, address2 = ?, phone = ?, sales_rep_code = ?, sales_rep_name = ?, assigned_user_id = ?, updated_at = datetime("now", "+9 hours") WHERE id = ?',
          [name, address1, address2, phone, salesRepCode, salesRepName, assignedUserId, existingId]);
        updated++;
      } else {
        db.run('INSERT INTO customers (customer_code, name, address1, address2, phone, sales_rep_code, sales_rep_name, assigned_user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [code, name, address1, address2, phone, salesRepCode, salesRepName, assignedUserId]);
        inserted++;
      }
    }

    saveDatabase();
    fs.unlinkSync(req.file.path);
    res.json({ inserted, updated });

  } catch (error) {
    console.error('得意先インポートエラー:', error);
    res.status(500).json({ error: error.message });
  }
});

// 仕入先インポート
app.post('/api/import/suppliers', requireAuth, requireAdmin, upload.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'ファイルがありません' });
    }

    const text = readCSVFile(req.file.path);
    const { rows } = parseCSV(text);

    let inserted = 0;
    let updated = 0;

    for (const row of rows) {
      // 基幹システム形式: 仕入先コード,仕入先名
      // または従来形式: supplier_code,name,...
      const code = row['仕入先コード'] || row.supplier_code;
      const name = row['仕入先名'] || row.name;
      const address1 = row.address1 || '';
      const phone = row.phone || '';

      if (!code || !name) continue;

      // 既存チェック
      const existStmt = db.prepare('SELECT id FROM suppliers WHERE supplier_code = ?');
      existStmt.bind([code]);
      const exists = existStmt.step();
      const existingId = exists ? existStmt.getAsObject().id : null;
      existStmt.free();

      if (exists) {
        db.run('UPDATE suppliers SET name = ?, address1 = ?, phone = ?, updated_at = datetime("now", "+9 hours") WHERE id = ?',
          [name, address1, phone, existingId]);
        updated++;
      } else {
        db.run('INSERT INTO suppliers (supplier_code, name, address1, phone) VALUES (?, ?, ?, ?)',
          [code, name, address1, phone]);
        inserted++;
      }
    }

    saveDatabase();
    fs.unlinkSync(req.file.path);
    res.json({ inserted, updated });

  } catch (error) {
    console.error('仕入先インポートエラー:', error);
    res.status(500).json({ error: error.message });
  }
});

// 部署インポート
app.post('/api/import/departments', requireAuth, requireAdmin, upload.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'ファイルがありません' });
    }

    const text = readCSVFile(req.file.path);
    const { rows } = parseCSV(text);

    let inserted = 0;
    let updated = 0;

    for (const row of rows) {
      const name = row.name;

      if (!name) continue;

      // 既存チェック
      const existStmt = db.prepare('SELECT id FROM departments WHERE name = ?');
      existStmt.bind([name]);
      const exists = existStmt.step();
      existStmt.free();

      if (exists) {
        updated++;
      } else {
        db.run('INSERT INTO departments (name) VALUES (?)', [name]);
        inserted++;
      }
    }

    saveDatabase();
    fs.unlinkSync(req.file.path);
    res.json({ inserted, updated });

  } catch (error) {
    console.error('部署インポートエラー:', error);
    res.status(500).json({ error: error.message });
  }
});

// 日報インポート（既存ツールからのExcel）
app.post('/api/import/reports', requireAuth, requireAdmin, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'ファイルが選択されていません' });
    }

    const XLSX = require('xlsx');
    const workbook = XLSX.readFile(req.file.path);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(worksheet, { header: 1 });

    // ヘッダー行をスキップ
    const rows = data.slice(1).filter(row => row[0] && row[1]);

    let inserted = 0;
    let skipped = 0;
    let duplicates = 0;

    for (const row of rows) {
      try {
        // カラム: NO, 実施日, 開始, 終了, 登録者, 得意先名, 面会者, 得意先, 活動種別, 内容, 訪問目的, 重要度
        const reportDate = row[1]; // 実施日
        const userName = row[4];   // 登録者
        const customerName = row[5]; // 得意先名
        const contactPerson = row[6]; // 面会者
        const activityType = row[8];  // 活動種別
        const content = row[9];       // 内容
        const visitPurpose = row[10]; // 訪問目的

        if (!reportDate || !userName) {
          skipped++;
          continue;
        }

        // 日付を変換
        let dateStr;
        if (typeof reportDate === 'number') {
          // Excelのシリアル値
          const date = new Date((reportDate - 25569) * 86400 * 1000);
          dateStr = date.toISOString().split('T')[0];
        } else {
          // 文字列の場合
          const dateParts = String(reportDate).split('/');
          if (dateParts.length === 3) {
            dateStr = `${dateParts[0]}-${dateParts[1].padStart(2, '0')}-${dateParts[2].padStart(2, '0')}`;
          } else {
            dateStr = reportDate;
          }
        }

        // ユーザーを検索
        const trimmedUserName = String(userName).trim();
        const userStmt = db.prepare('SELECT id FROM users WHERE name = ?');
        userStmt.bind([trimmedUserName]);
        let userId = null;
        if (userStmt.step()) {
          userId = userStmt.getAsObject().id;
        }
        userStmt.free();

        // ユーザーが存在しない場合はスキップ
        if (!userId) {
          console.log(`ユーザーが見つかりません: ${trimmedUserName}`);
          skipped++;
          continue;
        }

        // 勤務形態を判定
        let workStyle = 'office';
        if (activityType === '訪問') {
          workStyle = 'outside';
        }

        // 日報を作成（同じ日付・ユーザーの日報があるかチェック）
        let reportId;
        let isNewReport = false;
        const existingStmt = db.prepare('SELECT id FROM daily_reports WHERE user_id = ? AND report_date = ?');
        existingStmt.bind([userId, dateStr]);
        if (existingStmt.step()) {
          reportId = existingStmt.getAsObject().id;
        }
        existingStmt.free();

        if (!reportId) {
          // 新規日報作成（確認済みステータスで登録）
          db.run(`INSERT INTO daily_reports (user_id, report_date, work_style, status, created_at, updated_at)
                  VALUES (?, ?, ?, 'confirmed', datetime('now', '+9 hours'), datetime('now', '+9 hours'))`, [userId, dateStr, workStyle]);
          reportId = db.exec('SELECT last_insert_rowid() as id')[0].values[0][0];
          isNewReport = true;
        }

        // 活動種別が「訪問」の場合のみ訪問記録を作成
        if (activityType === '訪問') {
          // 顧客を検索（担当者情報も取得）
          let customerId = null;
          let supplierId = null;
          let visitType = 'customer';
          let assignedUserId = null;
          const cleanName = customerName ? String(customerName).trim() : '';
          const normalizedName = normalizeString(cleanName);
          
          if (cleanName) {
            // 全顧客を取得して正規化比較
            const allCustStmt = db.prepare('SELECT id, name, assigned_user_id FROM customers');
            while (allCustStmt.step()) {
              const cust = allCustStmt.getAsObject();
              const normalizedCustName = normalizeString(cust.name);
              // 部分一致または正規化後の一致
              if (normalizedCustName.includes(normalizedName) || normalizedName.includes(normalizedCustName)) {
                customerId = cust.id;
                assignedUserId = cust.assigned_user_id;
                break;
              }
            }
            allCustStmt.free();
            
            // 顧客で見つからない場合は仕入先を検索
            if (!customerId) {
              const allSuppStmt = db.prepare('SELECT id, name FROM suppliers');
              while (allSuppStmt.step()) {
                const supp = allSuppStmt.getAsObject();
                const normalizedSuppName = normalizeString(supp.name);
                if (normalizedSuppName.includes(normalizedName) || normalizedName.includes(normalizedSuppName)) {
                  supplierId = supp.id;
                  visitType = 'supplier';
                  break;
                }
              }
              allSuppStmt.free();
            }
          }

          // 重複チェック強化：同じ担当者が同じ日に同じ客先への訪問があるかチェック
          let isDuplicate = false;
          
          // DBの全日報から、同じ日付・同じユーザー・同じ顧客/仕入先の訪問記録を検索
          const dupQuery = `
            SELECT cv.id FROM customer_visits cv
            JOIN daily_reports dr ON cv.report_id = dr.id
            WHERE dr.user_id = ? AND dr.report_date = ?
              AND (
                (cv.customer_id = ? AND ? IS NOT NULL)
                OR (cv.supplier_id = ? AND ? IS NOT NULL)
                OR (cv.customer_name_manual = ? AND ? != '')
              )
          `;
          const dupStmt = db.prepare(dupQuery);
          dupStmt.bind([userId, dateStr, customerId, customerId, supplierId, supplierId, cleanName, cleanName]);
          isDuplicate = dupStmt.step();
          dupStmt.free();

          if (isDuplicate) {
            duplicates++;
            continue; // 重複はスキップ
          }

          // 訪問目的をマッピング
          let purposeValue = '';
          if (visitPurpose) {
            const purposeMap = {
              '定期訪問': '既存フォロー',
              '新規訪問': '新規開拓',
              '年末挨拶': 'その他',
              '年始挨拶': 'その他',
              '打ち合わせ': '打ち合わせ',
              '商談': '商談'
            };
            purposeValue = purposeMap[visitPurpose] || visitPurpose;
          }

          // 訪問記録を追加
          const meetingContent = content ? String(content).replace(/\\n/g, '\n') : '';
          db.run(`INSERT INTO customer_visits (report_id, visit_type, customer_id, supplier_id, customer_name_manual, visit_purpose, meeting_content, created_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', '+9 hours'))`,
            [reportId, visitType, customerId, supplierId, (!customerId && !supplierId) ? (customerName || '').trim() : null, purposeValue, meetingContent]);
          
          const visitId = db.exec('SELECT last_insert_rowid() as id')[0].values[0][0];

          // 登録者と得意先担当者が異なる場合は同行扱い（顧客訪問の場合のみ）
          if (customerId && assignedUserId && assignedUserId !== userId) {
            // 同行者として登録（登録者を同行者に追加）
            db.run(`INSERT INTO visit_companions (visit_id, user_id) VALUES (?, ?)`, [visitId, userId]);
            
            // 日報の所有者を得意先担当者に変更
            if (isNewReport) {
              db.run(`UPDATE daily_reports SET user_id = ? WHERE id = ?`, [assignedUserId, reportId]);
            }
          }
        } else {
          // 訪問以外は業務内容に記録
          const workContent = `【${activityType || 'その他'}】${customerName || ''}\n${content || ''}`.trim();
          db.run(`UPDATE daily_reports SET work_content = COALESCE(work_content || '\n', '') || ? WHERE id = ?`,
            [workContent, reportId]);
        }

        inserted++;
      } catch (rowError) {
        console.error('行処理エラー:', rowError);
        skipped++;
      }
    }

    fs.unlinkSync(req.file.path);
    saveDatabase();
    res.json({ inserted, skipped, duplicates });

  } catch (error) {
    console.error('日報インポートエラー:', error);
    res.status(500).json({ error: error.message });
  }
});

// 日報エクスポート（Excel）
app.get('/api/export/reports', requireAuth, async (req, res) => {
  try {
    const { from, to, user_id } = req.query;

    if (!from || !to) {
      return res.status(400).json({ error: '期間を指定してください' });
    }

    let query = `
      SELECT dr.*, u.name as user_name, d.name as department_name
      FROM daily_reports dr
      JOIN users u ON dr.user_id = u.id
      LEFT JOIN departments d ON u.department_id = d.id
      WHERE dr.report_date >= ? AND dr.report_date <= ?
    `;
    const params = [from, to];

    if (user_id) {
      query += ' AND dr.user_id = ?';
      params.push(user_id);
    }

    query += ' ORDER BY dr.report_date DESC, dr.user_id';

    const reports = [];
    const stmt = db.prepare(query);
    stmt.bind(params);
    while (stmt.step()) {
      reports.push(stmt.getAsObject());
    }
    stmt.free();

    // 訪問データを取得
    const exportData = [];
    let no = 1;

    for (const report of reports) {
      const visitStmt = db.prepare(`
        SELECT cv.*, c.name as customer_name_master, s.name as supplier_name_master
        FROM customer_visits cv
        LEFT JOIN customers c ON cv.customer_id = c.id
        LEFT JOIN suppliers s ON cv.supplier_id = s.id
        WHERE cv.report_id = ?
      `);
      visitStmt.bind([report.id]);

      while (visitStmt.step()) {
        const visit = visitStmt.getAsObject();
        const targetName = visit.customer_name_master || visit.supplier_name_master || visit.customer_name_manual || '';

        exportData.push({
          'NO': no++,
          '実施日': report.report_date,
          '登録者': report.user_name,
          '部署': report.department_name || '',
          '訪問先種別': visit.visit_type === 'supplier' ? '仕入先' : '得意先',
          '訪問先名': targetName,
          '訪問目的': visit.visit_purpose || '',
          '商談内容': visit.meeting_content || '',
          '確度': visit.probability || '',
          'ステータス': report.status === 'confirmed' ? '確認済' : (report.status === 'submitted' ? '提出済' : '下書き')
        });
      }
      visitStmt.free();

      // 訪問がない場合も日報情報を出力
      if (exportData.length === 0 || exportData[exportData.length - 1]['実施日'] !== report.report_date || 
          exportData[exportData.length - 1]['登録者'] !== report.user_name) {
        // 業務内容がある場合のみ追加
        if (report.work_content || report.achievements) {
          exportData.push({
            'NO': no++,
            '実施日': report.report_date,
            '登録者': report.user_name,
            '部署': report.department_name || '',
            '訪問先種別': '-',
            '訪問先名': '-',
            '訪問目的': '-',
            '商談内容': `【業務内容】${report.work_content || ''}\n【成果】${report.achievements || ''}`,
            '確度': '',
            'ステータス': report.status === 'confirmed' ? '確認済' : (report.status === 'submitted' ? '提出済' : '下書き')
          });
        }
      }
    }

    // Excelファイル作成
    const XLSX = require('xlsx');
    const ws = XLSX.utils.json_to_sheet(exportData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '日報データ');

    // ファイル名
    const fileName = `日報エクスポート_${from}_${to}.xlsx`;

    // バッファとして出力
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
    res.send(buffer);

  } catch (error) {
    console.error('日報エクスポートエラー:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// 顧客・仕入先別訪問履歴API
// ============================================

// 訪問記録の種別変更（顧客⇔仕入先）
app.put('/api/visits/:id/change-type', requireAuth, (req, res) => {
  try {
    const visitId = req.params.id;
    const { visit_type, target_id } = req.body;
    
    if (!visit_type || !['customer', 'supplier'].includes(visit_type)) {
      return res.status(400).json({ error: '訪問先種別が不正です' });
    }
    
    // 訪問記録を取得して権限チェック
    const stmt = db.prepare(`
      SELECT cv.*, dr.user_id 
      FROM customer_visits cv
      JOIN daily_reports dr ON cv.report_id = dr.id
      WHERE cv.id = ?
    `);
    stmt.bind([visitId]);
    if (!stmt.step()) {
      stmt.free();
      return res.status(404).json({ error: '訪問記録が見つかりません' });
    }
    const visit = stmt.getAsObject();
    stmt.free();
    
    // 自分の日報か管理者のみ変更可能
    if (visit.user_id !== req.session.user.id && req.session.user.role !== 'admin') {
      return res.status(403).json({ error: '変更権限がありません' });
    }
    
    // 更新
    if (visit_type === 'customer') {
      db.run(`UPDATE customer_visits SET visit_type = 'customer', customer_id = ?, supplier_id = NULL WHERE id = ?`,
        [target_id || null, visitId]);
    } else {
      db.run(`UPDATE customer_visits SET visit_type = 'supplier', customer_id = NULL, supplier_id = ? WHERE id = ?`,
        [target_id || null, visitId]);
    }
    
    saveDatabase();
    res.json({ success: true });
  } catch (error) {
    console.error('訪問記録種別変更エラー:', error);
    res.status(500).json({ error: error.message });
  }
});

// 月次レポート生成API
app.get('/api/monthly-report', requireAuth, (req, res) => {
  try {
    const { from, to, department_id, user_id, customer_id, supplier_id } = req.query;

    if (!from || !to) {
      return res.status(400).json({ error: '期間を指定してください' });
    }

    // 基本クエリ
    let reportQuery = `
      SELECT dr.*, u.name as user_name, d.name as department_name
      FROM daily_reports dr
      JOIN users u ON dr.user_id = u.id
      LEFT JOIN departments d ON u.department_id = d.id
      WHERE dr.report_date >= ? AND dr.report_date <= ?
        AND dr.status IN ('submitted', 'confirmed')
    `;
    const params = [from, to];

    if (user_id) {
      reportQuery += ' AND dr.user_id = ?';
      params.push(user_id);
    } else if (department_id) {
      reportQuery += ' AND u.department_id = ?';
      params.push(department_id);
    }

    // 顧客フィルター
    if (customer_id) {
      reportQuery += ' AND EXISTS (SELECT 1 FROM customer_visits cv WHERE cv.report_id = dr.id AND cv.customer_id = ?)';
      params.push(customer_id);
    }

    // 仕入先フィルター
    if (supplier_id) {
      reportQuery += ' AND EXISTS (SELECT 1 FROM customer_visits cv WHERE cv.report_id = dr.id AND cv.supplier_id = ?)';
      params.push(supplier_id);
    }

    reportQuery += ' ORDER BY dr.report_date DESC';

    // 日報取得
    const reports = [];
    const reportStmt = db.prepare(reportQuery);
    reportStmt.bind(params);
    while (reportStmt.step()) {
      reports.push(reportStmt.getAsObject());
    }
    reportStmt.free();

    const reportIds = reports.map(r => r.id);

    // 訪問データ取得
    let visits = [];
    if (reportIds.length > 0) {
      let visitQuery = `
        SELECT cv.*, dr.report_date, dr.user_id, u.name as user_name,
               c.name as customer_name, s.name as supplier_name
        FROM customer_visits cv
        JOIN daily_reports dr ON cv.report_id = dr.id
        JOIN users u ON dr.user_id = u.id
        LEFT JOIN customers c ON cv.customer_id = c.id
        LEFT JOIN suppliers s ON cv.supplier_id = s.id
        WHERE cv.report_id IN (${reportIds.join(',')})
        ORDER BY dr.report_date DESC
      `;
      const visitStmt = db.prepare(visitQuery);
      while (visitStmt.step()) {
        visits.push(visitStmt.getAsObject());
      }
      visitStmt.free();
    }

    // 同行データ取得
    let companions = [];
    if (reportIds.length > 0) {
      const compQuery = `
        SELECT vc.*, cv.report_id, u.name as user_name
        FROM visit_companions vc
        JOIN customer_visits cv ON vc.visit_id = cv.id
        JOIN users u ON vc.user_id = u.id
        WHERE cv.report_id IN (${reportIds.join(',')})
      `;
      const compStmt = db.prepare(compQuery);
      while (compStmt.step()) {
        companions.push(compStmt.getAsObject());
      }
      compStmt.free();
    }

    // 統計計算
    const memberMap = new Map();
    reports.forEach(r => {
      if (!memberMap.has(r.user_id)) {
        memberMap.set(r.user_id, {
          name: r.user_name,
          department: r.department_name,
          reportCount: 0,
          visitCount: 0,
          companionCount: 0
        });
      }
      memberMap.get(r.user_id).reportCount++;
    });

    visits.forEach(v => {
      if (memberMap.has(v.user_id)) {
        memberMap.get(v.user_id).visitCount++;
      }
    });

    // 同行カウント
    companions.forEach(c => {
      if (!memberMap.has(c.user_id)) {
        memberMap.set(c.user_id, {
          name: c.user_name,
          department: '',
          reportCount: 0,
          visitCount: 0,
          companionCount: 0
        });
      }
      memberMap.get(c.user_id).companionCount++;
    });

    // 訪問先集計
    const customerCounts = {};
    const supplierCounts = {};
    visits.forEach(v => {
      const name = v.customer_name || v.supplier_name || v.customer_name_manual;
      if (name) {
        if (v.visit_type === 'supplier') {
          supplierCounts[name] = (supplierCounts[name] || 0) + 1;
        } else {
          customerCounts[name] = (customerCounts[name] || 0) + 1;
        }
      }
    });

    // ハイライト（商談内容が充実しているもの上位10件）
    const highlights = visits
      .filter(v => v.meeting_content && v.meeting_content.length > 50)
      .sort((a, b) => (b.meeting_content?.length || 0) - (a.meeting_content?.length || 0))
      .slice(0, 10)
      .map(v => ({
        customerName: v.customer_name || v.supplier_name || v.customer_name_manual || '不明',
        date: v.report_date,
        userName: v.user_name,
        content: v.meeting_content
      }));

    res.json({
      summary: {
        reportCount: reports.length,
        visitCount: visits.length,
        customerVisits: visits.filter(v => v.visit_type === 'customer').length,
        supplierVisits: visits.filter(v => v.visit_type === 'supplier').length,
        memberCount: memberMap.size
      },
      customers: Object.entries(customerCounts)
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 30),
      suppliers: Object.entries(supplierCounts)
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 20),
      memberStats: Array.from(memberMap.values())
        .sort((a, b) => b.visitCount - a.visitCount),
      highlights
    });

  } catch (error) {
    console.error('月次レポートエラー:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// Sansan連携API
// ============================================

// Sansan設定取得
app.get('/api/sansan/settings', requireAuth, requireAdmin, (req, res) => {
  try {
    const stmt = db.prepare('SELECT * FROM sansan_settings WHERE id = 1');
    stmt.step();
    const settings = stmt.getAsObject();
    stmt.free();
    
    // APIキーはマスク表示
    if (settings.api_key) {
      settings.api_key_masked = settings.api_key.substring(0, 8) + '****' + settings.api_key.substring(settings.api_key.length - 4);
      settings.has_api_key = true;
    } else {
      settings.has_api_key = false;
    }
    delete settings.api_key; // 生のキーは返さない
    
    res.json(settings);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Sansan設定保存
app.post('/api/sansan/settings', requireAuth, requireAdmin, (req, res) => {
  try {
    const { api_key, enabled } = req.body;
    
    if (api_key) {
      db.run('UPDATE sansan_settings SET api_key = ?, enabled = ?, updated_at = datetime("now", "+9 hours") WHERE id = 1',
        [api_key, enabled ? 1 : 0]);
    } else {
      db.run('UPDATE sansan_settings SET enabled = ?, updated_at = datetime("now", "+9 hours") WHERE id = 1',
        [enabled ? 1 : 0]);
    }
    
    saveDatabase();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Sansan接続テスト
app.post('/api/sansan/test', requireAuth, requireAdmin, async (req, res) => {
  try {
    const stmt = db.prepare('SELECT api_key FROM sansan_settings WHERE id = 1');
    stmt.step();
    const { api_key } = stmt.getAsObject();
    stmt.free();
    
    if (!api_key) {
      return res.status(400).json({ error: 'APIキーが設定されていません' });
    }
    
    // Sansan APIに接続テスト（タグ一覧を取得してみる）- v6.0 API使用
    const response = await fetch('https://api.sansan.com/v6.0/tags', {
      method: 'GET',
      headers: {
        'X-Sansan-Api-Key': api_key,
        'Content-Type': 'application/json'
      }
    });
    
    if (response.ok) {
      const data = await response.json();
      res.json({ success: true, message: '接続成功', tagCount: data.data?.length || 0 });
    } else {
      const errorData = await response.json().catch(() => ({}));
      res.status(response.status).json({ 
        error: `接続失敗 (${response.status})`, 
        details: errorData.message || response.statusText 
      });
    }
  } catch (error) {
    res.status(500).json({ error: '接続エラー: ' + error.message });
  }
});

// Sansan名刺検索（名前または会社名で検索）
app.get('/api/sansan/search', requireAuth, async (req, res) => {
  try {
    const stmt = db.prepare('SELECT api_key, enabled FROM sansan_settings WHERE id = 1');
    stmt.step();
    const settings = stmt.getAsObject();
    stmt.free();
    
    if (!settings.enabled || !settings.api_key) {
      return res.status(400).json({ error: 'Sansan連携が無効です' });
    }
    
    const { name, company, email, department, tel, limit, range } = req.query;
    if (!name && !company && !email && !department && !tel) {
      return res.status(400).json({ error: '検索条件を指定してください' });
    }
    
    // 検索パラメータ構築（v6.0 API使用、range=allで全体検索）
    let searchUrl = 'https://api.sansan.com/v6.0/bizCards/search?';
    if (name) searchUrl += `name=${encodeURIComponent(name)}&`;
    if (company) searchUrl += `companyName=${encodeURIComponent(company)}&`;
    if (email) searchUrl += `email=${encodeURIComponent(email)}&`;
    if (department) searchUrl += `departmentName=${encodeURIComponent(department)}&`;
    if (tel) searchUrl += `tel=${encodeURIComponent(tel)}&`;
    // range: me=自分の名刺のみ, all=アクセス権のある全名刺
    searchUrl += `range=${range || 'all'}&`;
    searchUrl += `limit=${Math.min(parseInt(limit) || 50, 300)}`;
    
    const response = await fetch(searchUrl, {
      method: 'GET',
      headers: {
        'X-Sansan-Api-Key': settings.api_key,
        'Content-Type': 'application/json'
      }
    });
    
    if (response.ok) {
      const data = await response.json();
      // 必要な情報のみ返す
      const cards = (data.data || []).map(card => ({
        id: card.id,
        lastName: card.lastName,
        firstName: card.firstName,
        lastNameReading: card.lastNameReading,
        firstNameReading: card.firstNameReading,
        companyName: card.companyName,
        departmentName: card.departmentName,
        title: card.title,
        email: card.email,
        mobile: card.mobile,
        tel: card.tel,
        exchangeDate: card.exchangeDate,
        owner: card.owner?.name
      }));
      res.json({ cards, hasMore: data.hasMore });
    } else {
      const errorData = await response.json().catch(() => ({}));
      res.status(response.status).json({ 
        error: '検索エラー',
        details: errorData.message || `HTTP ${response.status}`
      });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Sansan連携状態確認（一般ユーザー向け）
app.get('/api/sansan/status', requireAuth, (req, res) => {
  try {
    const stmt = db.prepare('SELECT enabled FROM sansan_settings WHERE id = 1');
    stmt.step();
    const settings = stmt.getAsObject();
    stmt.free();
    res.json({ enabled: settings.enabled === 1 });
  } catch (error) {
    res.json({ enabled: false });
  }
});

// 顧客別訪問履歴
app.get('/api/customers/:id/visits', requireAuth, (req, res) => {
  const customerId = parseInt(req.params.id);
  
  // 顧客情報取得
  const customerStmt = db.prepare('SELECT * FROM customers WHERE id = ?');
  customerStmt.bind([customerId]);
  let customer = null;
  if (customerStmt.step()) {
    customer = customerStmt.getAsObject();
  }
  customerStmt.free();
  
  if (!customer) {
    return res.status(404).json({ error: '顧客が見つかりません' });
  }
  
  // 訪問履歴取得
  const results = [];
  const stmt = db.prepare(`
    SELECT cv.*, dr.report_date, dr.id as report_id, dr.status,
           u.name as user_name, d.name as department_name
    FROM customer_visits cv
    JOIN daily_reports dr ON cv.report_id = dr.id
    JOIN users u ON dr.user_id = u.id
    LEFT JOIN departments d ON u.department_id = d.id
    WHERE cv.customer_id = ? AND dr.status != 'draft'
    ORDER BY dr.report_date DESC
    LIMIT 100
  `);
  stmt.bind([customerId]);
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  
  res.json({
    customer,
    visits: results
  });
});

// 仕入先別訪問履歴
app.get('/api/suppliers/:id/visits', requireAuth, (req, res) => {
  const supplierId = parseInt(req.params.id);
  
  // 仕入先情報取得
  const supplierStmt = db.prepare('SELECT * FROM suppliers WHERE id = ?');
  supplierStmt.bind([supplierId]);
  let supplier = null;
  if (supplierStmt.step()) {
    supplier = supplierStmt.getAsObject();
  }
  supplierStmt.free();
  
  if (!supplier) {
    return res.status(404).json({ error: '仕入先が見つかりません' });
  }
  
  // 訪問履歴取得
  const results = [];
  const stmt = db.prepare(`
    SELECT cv.*, dr.report_date, dr.id as report_id, dr.status,
           u.name as user_name, d.name as department_name
    FROM customer_visits cv
    JOIN daily_reports dr ON cv.report_id = dr.id
    JOIN users u ON dr.user_id = u.id
    LEFT JOIN departments d ON u.department_id = d.id
    WHERE cv.supplier_id = ? AND dr.status != 'draft'
    ORDER BY dr.report_date DESC
    LIMIT 100
  `);
  stmt.bind([supplierId]);
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  
  res.json({
    supplier,
    visits: results
  });
});

// ============================================
// メール通知設定API
// ============================================

// メール設定取得
app.get('/api/settings/email', requireAuth, (req, res) => {
  if (req.session.user.role !== 'admin') {
    return res.status(403).json({ error: '権限がありません' });
  }
  
  try {
    const stmt = db.prepare('SELECT * FROM email_settings WHERE id = 1');
    let settings = null;
    if (stmt.step()) {
      settings = stmt.getAsObject();
      // パスワードは返さない
      if (settings) {
        settings.smtp_password = settings.smtp_password ? '********' : '';
      }
    }
    stmt.free();
    res.json(settings || {});
  } catch (e) {
    res.json({});
  }
});

// メール設定保存
app.post('/api/settings/email', requireAuth, (req, res) => {
  if (req.session.user.role !== 'admin') {
    return res.status(403).json({ error: '権限がありません' });
  }
  
  const { smtp_host, smtp_port, smtp_user, smtp_password, smtp_secure, from_address } = req.body;
  
  try {
    // email_settingsテーブルが存在するか確認
    const tableCheck = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='email_settings'");
    if (tableCheck.length === 0) {
      db.run(`
        CREATE TABLE email_settings (
          id INTEGER PRIMARY KEY,
          smtp_host TEXT,
          smtp_port INTEGER DEFAULT 587,
          smtp_user TEXT,
          smtp_password TEXT,
          smtp_secure INTEGER DEFAULT 0,
          from_address TEXT,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
    }
    
    // 既存設定確認
    const existsStmt = db.prepare('SELECT id FROM email_settings WHERE id = 1');
    const exists = existsStmt.step();
    existsStmt.free();
    
    if (exists) {
      // パスワードが********の場合は更新しない
      if (smtp_password && smtp_password !== '********') {
        db.run(`
          UPDATE email_settings SET 
            smtp_host = ?, smtp_port = ?, smtp_user = ?, smtp_password = ?,
            smtp_secure = ?, from_address = ?, updated_at = datetime('now', '+9 hours')
          WHERE id = 1
        `, [smtp_host, smtp_port || 587, smtp_user, smtp_password, smtp_secure ? 1 : 0, from_address]);
      } else {
        db.run(`
          UPDATE email_settings SET 
            smtp_host = ?, smtp_port = ?, smtp_user = ?,
            smtp_secure = ?, from_address = ?, updated_at = datetime('now', '+9 hours')
          WHERE id = 1
        `, [smtp_host, smtp_port || 587, smtp_user, smtp_secure ? 1 : 0, from_address]);
      }
    } else {
      db.run(`
        INSERT INTO email_settings (id, smtp_host, smtp_port, smtp_user, smtp_password, smtp_secure, from_address)
        VALUES (1, ?, ?, ?, ?, ?, ?)
      `, [smtp_host, smtp_port || 587, smtp_user, smtp_password, smtp_secure ? 1 : 0, from_address]);
    }
    
    saveDatabase();
    res.json({ success: true });
  } catch (error) {
    console.error('メール設定保存エラー:', error);
    res.status(500).json({ error: error.message });
  }
});

// メールテスト送信
app.post('/api/settings/email/test', requireAuth, async (req, res) => {
  if (req.session.user.role !== 'admin') {
    return res.status(403).json({ error: '権限がありません' });
  }
  
  const { to_address } = req.body;
  
  try {
    const result = await sendEmail(
      to_address,
      'テストメール - 営業日報システム',
      'これは営業日報システムからのテストメールです。\nメール設定が正しく行われています。'
    );
    
    if (result.success) {
      res.json({ success: true, message: 'テストメールを送信しました' });
    } else {
      res.status(500).json({ error: result.error });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// 通知設定API
// ============================================

// 通知設定取得
app.get('/api/settings/notifications', requireAuth, (req, res) => {
  if (req.session.user.role !== 'admin') {
    return res.status(403).json({ error: '権限がありません' });
  }
  
  try {
    // テーブル存在確認と作成
    const tableCheck = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='notification_settings'");
    if (tableCheck.length === 0) {
      db.run(`
        CREATE TABLE notification_settings (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          submitted_app INTEGER DEFAULT 1,
          submitted_email INTEGER DEFAULT 1,
          confirmed_email INTEGER DEFAULT 1,
          rejected_email INTEGER DEFAULT 1,
          comment_app INTEGER DEFAULT 1,
          comment_email INTEGER DEFAULT 1,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
      db.run('INSERT INTO notification_settings (id) VALUES (1)');
      saveDatabase();
    }
    
    const stmt = db.prepare('SELECT * FROM notification_settings WHERE id = 1');
    let settings = {};
    if (stmt.step()) {
      settings = stmt.getAsObject();
    }
    stmt.free();
    res.json(settings);
  } catch (e) {
    res.json({
      submitted_app: 1,
      submitted_email: 1,
      confirmed_email: 1,
      rejected_email: 1,
      comment_app: 1,
      comment_email: 1
    });
  }
});

// 通知設定保存
app.post('/api/settings/notifications', requireAuth, (req, res) => {
  if (req.session.user.role !== 'admin') {
    return res.status(403).json({ error: '権限がありません' });
  }
  
  const { submitted_app, submitted_email, confirmed_email, rejected_email, comment_app, comment_email } = req.body;
  
  try {
    // テーブル存在確認と作成
    const tableCheck = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='notification_settings'");
    if (tableCheck.length === 0) {
      db.run(`
        CREATE TABLE notification_settings (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          submitted_app INTEGER DEFAULT 1,
          submitted_email INTEGER DEFAULT 1,
          confirmed_email INTEGER DEFAULT 1,
          rejected_email INTEGER DEFAULT 1,
          comment_app INTEGER DEFAULT 1,
          comment_email INTEGER DEFAULT 1,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
      db.run('INSERT INTO notification_settings (id) VALUES (1)');
    }
    
    db.run(`
      UPDATE notification_settings SET 
        submitted_app = ?, submitted_email = ?,
        confirmed_email = ?, rejected_email = ?,
        comment_app = ?, comment_email = ?,
        updated_at = datetime('now', '+9 hours')
      WHERE id = 1
    `, [submitted_app, submitted_email, confirmed_email, rejected_email, comment_app, comment_email]);
    
    saveDatabase();
    res.json({ success: true });
  } catch (error) {
    console.error('通知設定保存エラー:', error);
    res.status(500).json({ error: error.message });
  }
});

// 通知設定を取得するヘルパー関数
function getNotificationSettings() {
  try {
    const tableCheck = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='notification_settings'");
    if (tableCheck.length === 0) {
      return {
        submitted_app: 1,
        submitted_email: 1,
        confirmed_email: 1,
        rejected_email: 1,
        comment_app: 1,
        comment_email: 1
      };
    }
    
    const stmt = db.prepare('SELECT * FROM notification_settings WHERE id = 1');
    let settings = null;
    if (stmt.step()) {
      settings = stmt.getAsObject();
    }
    stmt.free();
    
    return settings || {
      submitted_app: 1,
      submitted_email: 1,
      confirmed_email: 1,
      rejected_email: 1,
      comment_app: 1,
      comment_email: 1
    };
  } catch (e) {
    return {
      submitted_app: 1,
      submitted_email: 1,
      confirmed_email: 1,
      rejected_email: 1,
      comment_app: 1,
      comment_email: 1
    };
  }
}

// メール送信関数
async function sendEmail(to, subject, text) {
  try {
    const nodemailer = require('nodemailer');
    
    // 設定取得
    const stmt = db.prepare('SELECT * FROM email_settings WHERE id = 1');
    let settings = null;
    if (stmt.step()) {
      settings = stmt.getAsObject();
    }
    stmt.free();
    
    if (!settings || !settings.smtp_host) {
      return { success: false, error: 'メール設定がされていません' };
    }
    
    const transporter = nodemailer.createTransport({
      host: settings.smtp_host,
      port: settings.smtp_port || 587,
      secure: settings.smtp_secure === 1,
      auth: {
        user: settings.smtp_user,
        pass: settings.smtp_password
      }
    });
    
    await transporter.sendMail({
      from: settings.from_address || settings.smtp_user,
      to: to,
      subject: subject,
      text: text
    });
    
    return { success: true };
  } catch (error) {
    console.error('メール送信エラー:', error);
    return { success: false, error: error.message };
  }
}

// 通知メール送信（内部用）
async function sendNotificationEmail(userId, type, reportId) {
  try {
    // ユーザーのメールアドレス取得
    const userStmt = db.prepare('SELECT email, name FROM users WHERE id = ?');
    userStmt.bind([userId]);
    let user = null;
    if (userStmt.step()) {
      user = userStmt.getAsObject();
    }
    userStmt.free();
    
    if (!user || !user.email) {
      return;
    }
    
    // 日報情報取得
    const reportStmt = db.prepare(`
      SELECT dr.*, u.name as user_name 
      FROM daily_reports dr
      JOIN users u ON dr.user_id = u.id
      WHERE dr.id = ?
    `);
    reportStmt.bind([reportId]);
    let report = null;
    if (reportStmt.step()) {
      report = reportStmt.getAsObject();
    }
    reportStmt.free();
    
    if (!report) return;
    
    let subject, text;
    switch (type) {
      case 'submitted':
        subject = `【日報提出】${report.user_name}さんが日報を提出しました`;
        text = `${user.name}さん\n\n${report.user_name}さんが${report.report_date}の日報を提出しました。\n\n確認をお願いします。`;
        break;
      case 'comment':
        subject = `【コメント】日報にコメントがあります`;
        text = `${user.name}さん\n\n${report.report_date}の日報にコメントが追加されました。\n\n確認をお願いします。`;
        break;
      case 'rejected':
        subject = `【差し戻し】日報が差し戻されました`;
        text = `${user.name}さん\n\n${report.report_date}の日報が差し戻されました。\n\n内容を確認し、再提出をお願いします。`;
        break;
      case 'confirmed':
        subject = `【確認完了】日報が確認されました`;
        text = `${user.name}さん\n\n${report.report_date}の日報が確認されました。`;
        break;
      default:
        return;
    }
    
    await sendEmail(user.email, subject, text);
  } catch (error) {
    console.error('通知メール送信エラー:', error);
  }
}

// ============================================
// サーバー起動
// ============================================

async function startServer() {
  // SQL.js初期化
  const SQL = await initSqlJs();
  
  // データベースファイルを読み込み
  const dbPath = path.join(__dirname, 'db', 'database.sqlite');
  if (fs.existsSync(dbPath)) {
    const buffer = fs.readFileSync(dbPath);
    db = new SQL.Database(buffer);
    console.log('既存のデータベースを読み込みました。');
  } else {
    console.error('データベースが見つかりません。先に node db/init.js を実行してください。');
    process.exit(1);
  }

  // メール設定テーブルを追加（既存DBへの追加）
  try {
    // 既存テーブルを削除して新しい構造で再作成
    db.run(`DROP TABLE IF EXISTS email_settings`);
    db.run(`
      CREATE TABLE email_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        smtp_host TEXT,
        smtp_port INTEGER DEFAULT 587,
        smtp_secure INTEGER DEFAULT 0,
        smtp_user TEXT,
        smtp_password TEXT,
        from_address TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    // 初期レコード作成
    db.run(`INSERT INTO email_settings (id) VALUES (1)`);
    saveDatabase();
    console.log('メール設定テーブルを作成しました。');
  } catch (e) {
    console.log('メール設定テーブル: ', e.message);
  }

  // AI設定テーブルを追加
  try {
    db.run(`
      CREATE TABLE IF NOT EXISTS ai_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        api_key TEXT,
        model TEXT DEFAULT 'claude-3-5-haiku-20241022',
        enabled INTEGER DEFAULT 0,
        custom_prompt TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    // 初期レコードがなければ作成
    const aiCheck = db.exec('SELECT COUNT(*) FROM ai_settings WHERE id = 1');
    if (aiCheck[0]?.values[0]?.[0] === 0) {
      db.run('INSERT INTO ai_settings (id) VALUES (1)');
    }
    saveDatabase();
    console.log('AI設定テーブルを確認しました。');
  } catch (e) {
    console.log('AI設定テーブル: ', e.message);
  }

  // お気に入り顧客テーブルを追加
  try {
    db.run(`
      CREATE TABLE IF NOT EXISTS favorite_customers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        customer_id INTEGER,
        supplier_id INTEGER,
        target_type TEXT NOT NULL CHECK(target_type IN ('customer', 'supplier')),
        sort_order INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
        FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE CASCADE,
        UNIQUE(user_id, customer_id, supplier_id)
      )
    `);
    console.log('お気に入り顧客テーブルを確認しました。');
  } catch (e) {
    console.log('お気に入り顧客テーブル: ', e.message);
  }

  // 顧客テーブルに担当営業カラムを追加
  try {
    db.run(`ALTER TABLE customers ADD COLUMN assigned_user_id INTEGER REFERENCES users(id)`);
    console.log('顧客テーブルに担当営業カラムを追加しました。');
  } catch (e) {
    // カラムが既に存在する場合は無視
  }

  // タスクテーブルに期限カラムを追加
  try {
    db.run(`ALTER TABLE tasks ADD COLUMN due_date DATE`);
    console.log('タスクテーブルに期限カラムを追加しました。');
  } catch (e) {
    // カラムが既に存在する場合は無視
  }

  // 商品管理部を追加
  try {
    db.run(`INSERT OR IGNORE INTO departments (name) VALUES ('商品管理部')`);
    console.log('商品管理部を追加しました。');
  } catch (e) {
    // エラーは無視
  }

  // 共有テンプレートがなければ追加
  try {
    const templateCheck = db.exec('SELECT COUNT(*) as cnt FROM report_templates WHERE is_shared = 1');
    const templateCount = templateCheck[0]?.values[0]?.[0] || 0;
    
    if (templateCount === 0) {
      const templates = [
        { name: '🚗 外出・訪問のみ', work_content: '', achievements: '' },
        { name: '🏢 内勤日（出社・在宅）', work_content: '・見積作成：\n・受発注処理：\n・問い合わせ対応：\n・資料作成：', achievements: '' },
        { name: '🚗+🏢 外出＋内勤', work_content: '【内勤業務】\n・', achievements: '' },
        { name: '📋 週次振り返り（金曜用）', work_content: '', achievements: '【今週の成果】\n・\n\n【来週の予定】\n・' },
        { name: '🎯 商談・提案の日', work_content: '', achievements: '【商談結果】\n・\n\n【次のアクション】\n・' },
        { name: '📞 電話営業メイン', work_content: '【架電】\n・件数：  件\n・アポ獲得：  件\n・反応良：\n\n【受電対応】\n・', achievements: '' }
      ];
      
      // 管理者のIDを取得（なければ1）
      let adminId = 1;
      try {
        const adminCheck = db.exec("SELECT id FROM users WHERE role = 'admin' LIMIT 1");
        if (adminCheck[0]?.values[0]?.[0]) {
          adminId = adminCheck[0].values[0][0];
        }
      } catch (e) {}
      
      templates.forEach(t => {
        db.run('INSERT INTO report_templates (user_id, name, work_content, achievements, is_shared) VALUES (?, ?, ?, ?, 1)',
          [adminId, t.name, t.work_content, t.achievements]);
      });
      console.log('共有テンプレートを追加しました。');
    }
  } catch (e) {
    console.log('テンプレート確認: ', e.message);
  }

  // 担当者ユーザーがなければ追加
  try {
    const userCheck = db.exec("SELECT COUNT(*) as cnt FROM users WHERE login_id = 'E101'");
    const userCount = userCheck[0]?.values[0]?.[0] || 0;
    
    if (userCount === 0) {
      const bcrypt = require('bcryptjs');
      const salesPassword = bcrypt.hashSync('sales123', 10);
      
      // 営業部（E）
      const salesUsers = [
        ['E101', '諸伏豊', 1],
        ['E102', '倉本雅康', 1],
        ['E103', '竹内亮', 1],
        ['E104', '久田祐輔', 1],
        ['E105', '吉田晃一', 1],
        ['E106', '城処剛', 1],
        ['E107', '武井貴也', 1],
        ['E108', '長澤友也', 1],
        ['E109', '岩崎友和', 1],
        ['E110', '森淳', 1],
        ['E111', '馬場光晴', 1],
        ['E112', '髙田健太', 1],
      ];

      // 国際事業部（G）
      const globalUsers = [
        ['G101', '奥山知廣', 2],
        ['G102', '竹林友樹', 2],
        ['G103', '古川みどり', 2],
      ];

      [...salesUsers, ...globalUsers].forEach(([loginId, name, deptId]) => {
        try {
          db.run('INSERT OR IGNORE INTO users (login_id, password_hash, name, email, department_id, role) VALUES (?, ?, ?, ?, ?, ?)',
            [loginId, salesPassword, name, `${loginId.toLowerCase()}@example.com`, deptId, 'sales']);
        } catch (e) {}
      });
      
      console.log('担当者ユーザーを追加しました。');
    }
  } catch (e) {
    console.log('担当者ユーザー確認: ', e.message);
  }

  // Sansan設定テーブル作成
  try {
    db.run(`CREATE TABLE IF NOT EXISTS sansan_settings (
      id INTEGER PRIMARY KEY,
      api_key TEXT,
      enabled INTEGER DEFAULT 0,
      updated_at TEXT
    )`);
    // 初期レコード
    const check = db.exec('SELECT COUNT(*) as cnt FROM sansan_settings');
    if (check[0].values[0][0] === 0) {
      db.run("INSERT INTO sansan_settings (id, enabled) VALUES (1, 0)");
    }
  } catch (e) {
    console.log('Sansan設定テーブル: ', e.message);
  }

  saveDatabase();
  
  app.listen(PORT, () => {
    console.log('');
    console.log('========================================');
    console.log('  営業日報システムが起動しました');
    console.log('========================================');
    console.log('');
    console.log(`  URL: http://localhost:${PORT}`);
    console.log('');
    console.log('  停止するには Ctrl+C を押してください');
    console.log('');
  });
}

// 終了時にデータベースを保存
process.on('SIGINT', () => {
  console.log('\nデータベースを保存しています...');
  saveDatabase();
  console.log('サーバーを停止しました。');
  process.exit();
});

startServer().catch(err => {
  console.error('起動エラー:', err);
  process.exit(1);
});
