// ============================================
// 営業日報システム - 共通JavaScript
// ============================================

// 現在のユーザー情報
let currentUser = null;

// 認証チェック
async function checkAuth() {
  try {
    const response = await fetch('/api/me');
    if (!response.ok) {
      window.location.href = '/login.html';
      return null;
    }
    currentUser = await response.json();
    
    // ユーザー名表示
    const userNameEl = document.getElementById('user-name');
    if (userNameEl) {
      userNameEl.textContent = `${currentUser.name}（${currentUser.department_name || '-'}）`;
    }
    
    // 権限に応じたナビゲーション追加
    updateNavigation();
    
    return currentUser;
  } catch (error) {
    console.error('認証エラー:', error);
    window.location.href = '/login.html';
    return null;
  }
}

// ナビゲーション更新（権限に応じて）
function updateNavigation() {
  if (!currentUser) return;
  
  const nav = document.getElementById('main-nav');
  if (!nav) return;
  
  // アシスタントの場合、日報一覧リンクを非表示にする
  if (currentUser.role === 'assistant') {
    const reportListLink = nav.querySelector('a[href="/report-list.html"]');
    if (reportListLink) {
      reportListLink.style.display = 'none';
    }
  }
  
  // チーム日報リンク（全ユーザーに表示）
  const hasTeamLink = nav.querySelector('a[href="/team-reports.html"]');
  if (!hasTeamLink) {
    const teamLink = document.createElement('a');
    teamLink.href = '/team-reports.html';
    teamLink.className = 'nav-link';
    teamLink.textContent = 'チーム日報';
    nav.appendChild(teamLink);
  }
  
  // 管理者用メニュー（ドロップダウン）
  if (currentUser.role === 'admin') {
    const hasAdminDropdown = nav.querySelector('.admin-dropdown');
    if (!hasAdminDropdown) {
      const dropdown = document.createElement('div');
      dropdown.className = 'admin-dropdown';
      dropdown.innerHTML = `
        <button class="nav-link admin-dropdown-btn">⚙️ 管理 ▾</button>
        <div class="admin-dropdown-menu">
          <a href="/admin-users.html" class="admin-dropdown-item">👤 ユーザー管理</a>
          <a href="/admin-masters.html" class="admin-dropdown-item">📋 マスター管理</a>
          <a href="/admin-import.html" class="admin-dropdown-item">📥 インポート</a>
          <a href="/admin-email.html" class="admin-dropdown-item">✉️ メール設定</a>
          <a href="/admin-notifications.html" class="admin-dropdown-item">🔔 通知設定</a>
          <a href="/admin-ai.html" class="admin-dropdown-item">🤖 AI設定</a>
          <a href="/admin-sansan.html" class="admin-dropdown-item">📇 Sansan連携</a>
        </div>
      `;
      nav.appendChild(dropdown);
      
      // ドロップダウン開閉
      const btn = dropdown.querySelector('.admin-dropdown-btn');
      const menu = dropdown.querySelector('.admin-dropdown-menu');
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        menu.classList.toggle('show');
      });
      
      // 外側クリックで閉じる
      document.addEventListener('click', () => {
        menu.classList.remove('show');
      });
    }
  }
  
  // 現在のページをアクティブに
  const currentPath = window.location.pathname;
  nav.querySelectorAll('.nav-link').forEach(link => {
    if (link.getAttribute('href') === currentPath) {
      link.classList.add('active');
    } else {
      link.classList.remove('active');
    }
  });
}

// ログアウト
async function logout() {
  try {
    await fetch('/api/logout', { method: 'POST' });
    window.location.href = '/login.html';
  } catch (error) {
    console.error('ログアウトエラー:', error);
    window.location.href = '/login.html';
  }
}

// ============================================
// フォーマット関数
// ============================================

// 日付フォーマット（YYYY-MM-DD → YYYY/MM/DD）
function formatDate(dateStr) {
  if (!dateStr) return '-';
  const d = new Date(dateStr);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}/${month}/${day}`;
}

// 日付フォーマット（曜日付き）
function formatDateWithDay(dateStr) {
  if (!dateStr) return '-';
  const days = ['日', '月', '火', '水', '木', '金', '土'];
  const d = new Date(dateStr);
  const dayOfWeek = days[d.getDay()];
  return `${formatDate(dateStr)}（${dayOfWeek}）`;
}

// 勤務形態フォーマット
function formatWorkStyle(style) {
  const styles = {
    'office': '出社',
    'remote': '在宅',
    'outside': '外出'
  };
  return styles[style] || style || '-';
}

// ステータスフォーマット（バッジHTML）
function formatStatus(status) {
  const statusMap = {
    'draft': { label: '下書き', class: 'badge-draft' },
    'submitted': { label: '提出済み', class: 'badge-submitted' },
    'confirmed': { label: '確認済み', class: 'badge-confirmed' },
    'rejected': { label: '差し戻し', class: 'badge-rejected' }
  };
  const s = statusMap[status] || { label: status, class: 'badge-draft' };
  return `<span class="badge ${s.class}">${s.label}</span>`;
}

// ステータスラベルのみ
function getStatusLabel(status) {
  const labels = {
    'draft': '下書き',
    'submitted': '提出済み',
    'confirmed': '確認済み',
    'rejected': '差し戻し'
  };
  return labels[status] || status;
}

// 確度フォーマット
function formatProbability(prob) {
  const probMap = {
    'A': 'A（90%以上）',
    'B': 'B（50〜90%）',
    'C': 'C（10〜50%）',
    'D': 'D（10%未満）'
  };
  return probMap[prob] || prob || '-';
}

// 金額フォーマット（カンマ区切り）
function formatAmount(amount) {
  if (!amount && amount !== 0) return '-';
  return Number(amount).toLocaleString() + ' 円';
}

// 日時フォーマット
function formatDateTime(dateTimeStr) {
  if (!dateTimeStr) return '-';
  const d = new Date(dateTimeStr);
  const date = formatDate(dateTimeStr);
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return `${date} ${hours}:${minutes}`;
}

// ============================================
// ユーティリティ関数
// ============================================

// 今日の日付を取得（YYYY-MM-DD形式）
function getTodayString() {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// URLパラメータ取得
function getUrlParam(name) {
  const params = new URLSearchParams(window.location.search);
  return params.get(name);
}

// エスケープ処理（XSS対策）
function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// テキストを改行込みでHTML表示
function nl2br(str) {
  if (!str) return '';
  return escapeHtml(str).replace(/\n/g, '<br>');
}

// 長文を読みやすく整形（句点で改行）
function formatLongText(str) {
  if (!str) return '';
  // まず改行をbrに変換
  let formatted = escapeHtml(str).replace(/\n/g, '<br>');
  // 句点「。」の後に改行がなければ追加（ただし既にbrがある場合は追加しない）
  formatted = formatted.replace(/。(?!<br>|$)/g, '。<br>');
  return formatted;
}

// デバウンス（検索入力など用）
function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

// 確認ダイアログ
function confirmAction(message) {
  return confirm(message);
}

// 通知表示（簡易版）
function showNotification(message, type = 'info') {
  alert(message);
}

// ============================================
// API呼び出しヘルパー
// ============================================

async function apiGet(url) {
  const response = await fetch(url);
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'APIエラー');
  }
  return response.json();
}

async function apiPost(url, data) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'APIエラー');
  }
  return response.json();
}

async function apiPut(url, data) {
  const response = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'APIエラー');
  }
  return response.json();
}

async function apiDelete(url) {
  const response = await fetch(url, { method: 'DELETE' });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'APIエラー');
  }
  return response.json();
}
