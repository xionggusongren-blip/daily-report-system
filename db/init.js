const initSqlJs = require('sql.js');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');

async function initDatabase() {
  // SQL.js初期化
  const SQL = await initSqlJs();
  const db = new SQL.Database();

  console.log('データベースを初期化しています...');

  // テーブル作成
  db.run(`
    -- 部署テーブル
    CREATE TABLE IF NOT EXISTS departments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- ユーザーテーブル
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      login_id TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      email TEXT,
      department_id INTEGER,
      role TEXT NOT NULL CHECK(role IN ('sales', 'assistant', 'manager', 'admin')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (department_id) REFERENCES departments(id)
    );

    -- 顧客テーブル
    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_code TEXT UNIQUE,
      name TEXT NOT NULL,
      address1 TEXT,
      address2 TEXT,
      postal_code TEXT,
      phone TEXT,
      closing_day TEXT,
      sales_rep_code TEXT,
      sales_rep_name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- 仕入先テーブル
    CREATE TABLE IF NOT EXISTS suppliers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      supplier_code TEXT UNIQUE,
      name TEXT NOT NULL,
      address1 TEXT,
      phone TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- メーカーテーブル
    CREATE TABLE IF NOT EXISTS manufacturers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- 日報テーブル
    CREATE TABLE IF NOT EXISTS daily_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      report_date DATE NOT NULL,
      work_style TEXT CHECK(work_style IN ('office', 'remote', 'outside')),
      work_content TEXT,
      achievements TEXT,
      kpi_results TEXT,
      issues TEXT,
      consultation TEXT,
      next_day_plan TEXT,
      status TEXT DEFAULT 'draft' CHECK(status IN ('draft', 'submitted', 'confirmed', 'rejected')),
      confirmed_by INTEGER,
      confirmed_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (confirmed_by) REFERENCES users(id)
    );

    -- タスクテーブル
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      report_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      is_completed INTEGER DEFAULT 0,
      carried_from_report_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (report_id) REFERENCES daily_reports(id) ON DELETE CASCADE,
      FOREIGN KEY (carried_from_report_id) REFERENCES daily_reports(id)
    );

    -- 顧客訪問テーブル
    CREATE TABLE IF NOT EXISTS customer_visits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      report_id INTEGER NOT NULL,
      visit_type TEXT DEFAULT 'customer' CHECK(visit_type IN ('customer', 'supplier')),
      customer_id INTEGER,
      supplier_id INTEGER,
      customer_name_manual TEXT,
      visit_purpose TEXT,
      meeting_content TEXT,
      deal_amount INTEGER,
      probability TEXT CHECK(probability IN ('A', 'B', 'C', 'D')),
      next_action TEXT,
      next_action_date DATE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (report_id) REFERENCES daily_reports(id) ON DELETE CASCADE,
      FOREIGN KEY (customer_id) REFERENCES customers(id),
      FOREIGN KEY (supplier_id) REFERENCES suppliers(id)
    );

    -- 同行者テーブル
    CREATE TABLE IF NOT EXISTS visit_companions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      visit_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      FOREIGN KEY (visit_id) REFERENCES customer_visits(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    -- 訪問-メーカー紐付けテーブル
    CREATE TABLE IF NOT EXISTS visit_manufacturers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      visit_id INTEGER NOT NULL,
      manufacturer_id INTEGER NOT NULL,
      FOREIGN KEY (visit_id) REFERENCES customer_visits(id) ON DELETE CASCADE,
      FOREIGN KEY (manufacturer_id) REFERENCES manufacturers(id)
    );

    -- コメントテーブル
    CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      report_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (report_id) REFERENCES daily_reports(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    -- 通知履歴テーブル
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      to_user_id INTEGER NOT NULL,
      report_id INTEGER,
      email_sent INTEGER DEFAULT 0,
      sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (to_user_id) REFERENCES users(id),
      FOREIGN KEY (report_id) REFERENCES daily_reports(id)
    );

    -- 添付ファイルテーブル
    CREATE TABLE IF NOT EXISTS attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      report_id INTEGER NOT NULL,
      original_name TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      file_size INTEGER,
      mime_type TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (report_id) REFERENCES daily_reports(id) ON DELETE CASCADE
    );

    -- お気に入り顧客テーブル
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
      FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE CASCADE
    );

    -- テンプレートテーブル
    CREATE TABLE IF NOT EXISTS report_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      work_content TEXT,
      achievements TEXT,
      issues TEXT,
      consultation TEXT,
      is_shared INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  console.log('テーブルを作成しました。');

  // サンプルデータ投入
  // 部署
  const departments = ['営業部', '国際事業部', '営業推進部', 'システム部', '商品管理部'];
  departments.forEach(name => {
    db.run('INSERT OR IGNORE INTO departments (name) VALUES (?)', [name]);
  });
  console.log('部署データを投入しました。');

  // メーカー（サンプル）
  const manufacturers = [
    'TDK', 'muRata', 'ROHM', 'KOA', 'Maxell', 
    'Panasonic', 'TAIYO YUDEN', 'KYOCERA', 'NICHICON', 'NIPPON CHEMI-CON',
    'VISHAY', 'YAGEO', 'SAMSUNG', 'Texas Instruments', 'STMicroelectronics'
  ];
  manufacturers.forEach(name => {
    db.run('INSERT OR IGNORE INTO manufacturers (name) VALUES (?)', [name]);
  });
  console.log('メーカーデータを投入しました。');

  // ユーザー作成
  const adminPassword = bcrypt.hashSync('admin123', 10);
  const managerPassword = bcrypt.hashSync('manager123', 10);
  const salesPassword = bcrypt.hashSync('sales123', 10);

  // 管理者
  db.run('INSERT OR IGNORE INTO users (login_id, password_hash, name, email, department_id, role) VALUES (?, ?, ?, ?, ?, ?)',
    ['admin', adminPassword, '管理者', 'admin@example.com', 4, 'admin']);

  // 上長サンプル（各部署）
  db.run('INSERT OR IGNORE INTO users (login_id, password_hash, name, email, department_id, role) VALUES (?, ?, ?, ?, ?, ?)',
    ['manager1', managerPassword, '山田部長', 'yamada@example.com', 1, 'manager']);
  db.run('INSERT OR IGNORE INTO users (login_id, password_hash, name, email, department_id, role) VALUES (?, ?, ?, ?, ?, ?)',
    ['manager2', managerPassword, '鈴木課長', 'suzuki@example.com', 2, 'manager']);

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

  // 営業部ユーザー登録
  salesUsers.forEach(([loginId, name, deptId]) => {
    db.run('INSERT OR IGNORE INTO users (login_id, password_hash, name, email, department_id, role) VALUES (?, ?, ?, ?, ?, ?)',
      [loginId, salesPassword, name, `${loginId.toLowerCase()}@example.com`, deptId, 'sales']);
  });

  // 国際事業部ユーザー登録
  globalUsers.forEach(([loginId, name, deptId]) => {
    db.run('INSERT OR IGNORE INTO users (login_id, password_hash, name, email, department_id, role) VALUES (?, ?, ?, ?, ?, ?)',
      [loginId, salesPassword, name, `${loginId.toLowerCase()}@example.com`, deptId, 'sales']);
  });

  console.log('ユーザーデータを投入しました。');

  // 顧客サンプル
  db.run('INSERT OR IGNORE INTO customers (customer_code, name, address1, postal_code, phone) VALUES (?, ?, ?, ?, ?)',
    ['C001', '株式会社サンプル電子', '東京都千代田区1-1-1', '100-0001', '03-1234-5678']);
  db.run('INSERT OR IGNORE INTO customers (customer_code, name, address1, postal_code, phone) VALUES (?, ?, ?, ?, ?)',
    ['C002', '○○電機株式会社', '大阪府大阪市2-2-2', '530-0001', '06-1234-5678']);
  db.run('INSERT OR IGNORE INTO customers (customer_code, name, address1, postal_code, phone) VALUES (?, ?, ?, ?, ?)',
    ['C003', '△△工業株式会社', '愛知県名古屋市3-3-3', '450-0001', '052-123-4567']);

  console.log('顧客データを投入しました。');

  // 仕入先サンプル
  db.run('INSERT OR IGNORE INTO suppliers (supplier_code, name, address1, phone) VALUES (?, ?, ?, ?)',
    ['S001', 'Digi-Key', 'アメリカ ミネソタ州', '-']);
  db.run('INSERT OR IGNORE INTO suppliers (supplier_code, name, address1, phone) VALUES (?, ?, ?, ?)',
    ['S002', 'Mouser Electronics', 'アメリカ テキサス州', '-']);
  db.run('INSERT OR IGNORE INTO suppliers (supplier_code, name, address1, phone) VALUES (?, ?, ?, ?)',
    ['S003', 'チップワンストップ', '東京都港区', '03-0000-0000']);
  db.run('INSERT OR IGNORE INTO suppliers (supplier_code, name, address1, phone) VALUES (?, ?, ?, ?)',
    ['S004', 'コアスタッフ', '東京都新宿区', '03-0000-0000']);
  db.run('INSERT OR IGNORE INTO suppliers (supplier_code, name, address1, phone) VALUES (?, ?, ?, ?)',
    ['S005', 'マクニカ', '神奈川県横浜市', '045-000-0000']);

  console.log('仕入先データを投入しました。');

  // 共有テンプレート（user_id=1は管理者）
  // 訪問記録メインの運用に合わせて、業務内容は補助的な位置づけ
  const templates = [
    {
      name: '🚗 外出・訪問のみ',
      work_content: '',
      achievements: '',
      issues: '',
      consultation: '',
      description: '訪問記録だけ入力すればOK'
    },
    {
      name: '🏢 内勤日（出社・在宅）',
      work_content: '・見積作成：\n・受発注処理：\n・問い合わせ対応：\n・資料作成：',
      achievements: '',
      issues: '',
      consultation: '',
      description: '事務作業がメインの日用'
    },
    {
      name: '🚗+🏢 外出＋内勤',
      work_content: '【内勤業務】\n・',
      achievements: '',
      issues: '',
      consultation: '',
      description: '訪問と事務作業の両方ある日'
    },
    {
      name: '📋 週次振り返り（金曜用）',
      work_content: '',
      achievements: '【今週の成果】\n・\n\n【来週の予定】\n・',
      issues: '',
      consultation: '',
      description: '週末の振り返り・来週計画用'
    },
    {
      name: '🎯 商談・提案の日',
      work_content: '',
      achievements: '【商談結果】\n・\n\n【次のアクション】\n・',
      issues: '',
      consultation: '',
      description: '重要商談がある日用'
    },
    {
      name: '📞 電話営業メイン',
      work_content: '【架電】\n・件数：  件\n・アポ獲得：  件\n・反応良：\n\n【受電対応】\n・',
      achievements: '',
      issues: '',
      consultation: '',
      description: 'テレアポ・電話対応メインの日'
    }
  ];

  templates.forEach(t => {
    db.run(`
      INSERT OR IGNORE INTO report_templates (user_id, name, work_content, achievements, issues, consultation, is_shared)
      VALUES (1, ?, ?, ?, ?, ?, 1)
    `, [t.name, t.work_content, t.achievements, t.issues, t.consultation]);
  });
  console.log('共有テンプレートを投入しました。');

  // データベースをファイルに保存
  const data = db.export();
  const buffer = Buffer.from(data);
  const dbPath = path.join(__dirname, 'database.sqlite');
  fs.writeFileSync(dbPath, buffer);

  console.log('');
  console.log('=== 初期化完了 ===');
  console.log('');
  console.log('【テストユーザー】');
  console.log('管理者: admin / admin123');
  console.log('上長:   manager1 / manager123');
  console.log('営業:   sales1 / sales123');
  console.log('');

  db.close();
}

initDatabase().catch(err => {
  console.error('初期化エラー:', err);
  process.exit(1);
});
