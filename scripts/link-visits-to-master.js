/**
 * 訪問記録をマスターとリンクする一括修正スクリプト
 *
 * customer_name_manual を customers/suppliers テーブルと照合し、
 * マッチしたものに customer_id/supplier_id を設定します。
 */

const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

// 文字列正規化（全角・半角、㈱・株式会社などを統一）
function normalizeString(str) {
  if (!str) return '';
  return str
    .replace(/[\u3000]/g, ' ')  // 全角スペース→半角
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, s => String.fromCharCode(s.charCodeAt(0) - 0xFEE0))  // 全角英数→半角
    .replace(/[ァ-ン]/g, s => String.fromCharCode(s.charCodeAt(0) - 0x60))  // 全角カナ→半角
    .replace(/株式会社|㈱|\(株\)|（株）/g, '')
    .replace(/有限会社|㈲|\(有\)|（有）/g, '')
    .replace(/合同会社/g, '')
    .replace(/[\s\-－・]/g, '')
    .toLowerCase()
    .trim();
}

async function linkVisitsToMaster() {
  const SQL = await initSqlJs();
  const dbPath = path.join(__dirname, '..', 'db', 'database.sqlite');

  // バックアップ作成
  const backupPath = dbPath.replace('.sqlite', `_backup_${Date.now()}.sqlite`);
  fs.copyFileSync(dbPath, backupPath);
  console.log(`バックアップを作成しました: ${backupPath}`);

  const buffer = fs.readFileSync(dbPath);
  const db = new SQL.Database(buffer);

  // 顧客マスターを取得
  const customers = [];
  const custStmt = db.prepare('SELECT id, name FROM customers');
  while (custStmt.step()) {
    const row = custStmt.getAsObject();
    customers.push({
      id: row.id,
      name: row.name,
      normalized: normalizeString(row.name)
    });
  }
  custStmt.free();
  console.log(`顧客マスター: ${customers.length}件`);

  // 仕入先マスターを取得
  const suppliers = [];
  const suppStmt = db.prepare('SELECT id, name FROM suppliers');
  while (suppStmt.step()) {
    const row = suppStmt.getAsObject();
    suppliers.push({
      id: row.id,
      name: row.name,
      normalized: normalizeString(row.name)
    });
  }
  suppStmt.free();
  console.log(`仕入先マスター: ${suppliers.length}件`);

  // リンクされていない訪問記録を取得
  const visits = [];
  const visitStmt = db.prepare(`
    SELECT id, customer_name_manual, visit_type
    FROM customer_visits
    WHERE customer_name_manual IS NOT NULL
      AND customer_name_manual != ''
      AND customer_id IS NULL
      AND supplier_id IS NULL
  `);
  while (visitStmt.step()) {
    visits.push(visitStmt.getAsObject());
  }
  visitStmt.free();
  console.log(`リンクされていない訪問記録: ${visits.length}件`);

  let customerLinked = 0;
  let supplierLinked = 0;
  let notFound = 0;
  const notFoundNames = new Set();

  for (const visit of visits) {
    const normalizedVisitName = normalizeString(visit.customer_name_manual);

    // 顧客マスターから検索（完全一致優先）
    let matched = null;
    let matchType = null;

    // 完全一致を検索
    for (const cust of customers) {
      if (cust.normalized === normalizedVisitName) {
        matched = cust;
        matchType = 'customer';
        break;
      }
    }

    // 完全一致がなければ仕入先を検索
    if (!matched) {
      for (const supp of suppliers) {
        if (supp.normalized === normalizedVisitName) {
          matched = supp;
          matchType = 'supplier';
          break;
        }
      }
    }

    // 完全一致がなければ部分一致を試す（顧客）
    if (!matched) {
      for (const cust of customers) {
        if (cust.normalized.includes(normalizedVisitName) || normalizedVisitName.includes(cust.normalized)) {
          // 長さが近いもの（誤マッチを避ける）
          const lenDiff = Math.abs(cust.normalized.length - normalizedVisitName.length);
          if (lenDiff <= 5) {
            matched = cust;
            matchType = 'customer';
            break;
          }
        }
      }
    }

    // 部分一致（仕入先）
    if (!matched) {
      for (const supp of suppliers) {
        if (supp.normalized.includes(normalizedVisitName) || normalizedVisitName.includes(supp.normalized)) {
          const lenDiff = Math.abs(supp.normalized.length - normalizedVisitName.length);
          if (lenDiff <= 5) {
            matched = supp;
            matchType = 'supplier';
            break;
          }
        }
      }
    }

    if (matched) {
      if (matchType === 'customer') {
        db.run('UPDATE customer_visits SET customer_id = ?, visit_type = ? WHERE id = ?',
          [matched.id, 'customer', visit.id]);
        customerLinked++;
      } else {
        db.run('UPDATE customer_visits SET supplier_id = ?, visit_type = ? WHERE id = ?',
          [matched.id, 'supplier', visit.id]);
        supplierLinked++;
      }
    } else {
      notFound++;
      notFoundNames.add(visit.customer_name_manual);
    }
  }

  // データベースを保存
  const data = db.export();
  const outputBuffer = Buffer.from(data);
  fs.writeFileSync(dbPath, outputBuffer);

  console.log('\n=== 修正結果 ===');
  console.log(`顧客マスターとリンク: ${customerLinked}件`);
  console.log(`仕入先マスターとリンク: ${supplierLinked}件`);
  console.log(`マッチしなかった: ${notFound}件`);

  if (notFoundNames.size > 0) {
    console.log('\n=== マッチしなかった訪問先（最大20件） ===');
    const names = Array.from(notFoundNames).slice(0, 20);
    names.forEach(name => console.log(`  - ${name}`));
  }

  db.close();
  console.log('\n完了しました。');
}

linkVisitsToMaster().catch(err => {
  console.error('エラー:', err);
  process.exit(1);
});
