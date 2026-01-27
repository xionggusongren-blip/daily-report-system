const fs = require('fs');
const path = require('path');

const dbPath = 'C:/Tools/daily-report-system/db/database.sqlite';
const backupDir = 'C:/Tools/daily-report-system/backups';

if (!fs.existsSync(backupDir)) {
  fs.mkdirSync(backupDir);
}

const now = new Date();
const timestamp = now.getFullYear() +
  String(now.getMonth() + 1).padStart(2, '0') +
  String(now.getDate()).padStart(2, '0') + '_' +
  String(now.getHours()).padStart(2, '0') +
  String(now.getMinutes()).padStart(2, '0');

const backupPath = path.join(backupDir, `database_${timestamp}.sqlite`);

fs.copyFileSync(dbPath, backupPath);
console.log('Backup created:', backupPath);