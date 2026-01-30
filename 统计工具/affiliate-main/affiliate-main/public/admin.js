/**
 * 超级管理员前端脚本
 */

// API基础URL
const API_BASE = window.location.origin;

// 全局状态
let currentPage = 'dashboard';
let currentUserId = null;
let token = localStorage.getItem('token');
let currentAdmin = null; // 当前登录的超管信息

// 初始化
document.addEventListener('DOMContentLoaded', async () => {
  // 先检查登录状态
  const isAuthenticated = await checkAuth();
  
  if (!isAuthenticated) {
    return; // 如果认证失败，不继续初始化
  }
  
  // 绑定事件
  bindEvents();
  
  // 更新时间
  updateTime();
  setInterval(updateTime, 1000);
  
  // 加载初始页面（仪表板）
  switchPage('dashboard');
});

// 检查认证
async function checkAuth() {
  if (!token) {
    redirectToLogin();
    return false;
  }

  try {
    const response = await fetch(`${API_BASE}/api/auth/me`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    const data = await response.json();
    
    if (!data.success) {
      console.log('Token验证失败:', data.message);
      redirectToLogin();
      return false;
    }

    // 检查是否是超级管理员
    if (data.data.role !== 'super_admin') {
      alert('权限不足：需要超级管理员权限');
      redirectToLogin();
      return false;
    }
    
    // 保存当前管理员信息
    currentAdmin = data.data;

    // 显示管理员信息
    document.getElementById('adminName').textContent = data.data.username || data.data.email;
    return true;
  } catch (error) {
    console.error('认证检查失败:', error);
    redirectToLogin();
    return false;
  }
}

// 跳转到登录页
function redirectToLogin() {
  localStorage.removeItem('token');
  localStorage.removeItem('authToken');
  window.location.href = '/index.html';
}

// 绑定事件
function bindEvents() {
  // 导航菜单
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const page = item.dataset.page;
      switchPage(page);
    });
  });

  // 退出登录
  document.getElementById('logoutBtn').addEventListener('click', () => {
    if (confirm('确定要退出登录吗？')) {
      localStorage.removeItem('token');
      window.location.href = '/index.html';
    }
  });

  // 用户搜索
  document.getElementById('searchBtn').addEventListener('click', () => {
    loadUsers(1, document.getElementById('userSearch').value);
  });

  document.getElementById('userSearch').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      loadUsers(1, e.target.value);
    }
  });

  // 返回用户列表
  document.getElementById('backToUsers').addEventListener('click', () => {
    switchPage('users');
  });

  // 平台统计刷新
  const statsRefreshBtn = document.getElementById('statsRefreshBtn');
  if (statsRefreshBtn) {
    statsRefreshBtn.addEventListener('click', () => {
      loadPlatformStats();
    });
  }

  // 审计日志筛选
  document.getElementById('logFilterBtn').addEventListener('click', () => {
    loadAuditLogs(1);
  });

  // 用户详情选项卡
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      switchTab(tab);
    });
  });
  
  // 用户订单日期筛选
  const userOrdersFilterBtn = document.getElementById('userOrdersFilterBtn');
  if (userOrdersFilterBtn) {
    userOrdersFilterBtn.addEventListener('click', () => {
      if (currentUserId) {
        const startDate = document.getElementById('userOrdersStartDate').value;
        const endDate = document.getElementById('userOrdersEndDate').value;
        loadUserOrders(currentUserId, 1, startDate, endDate);
      }
    });
  }
  
  // 用户广告数据日期筛选
  const userAdsFilterBtn = document.getElementById('userAdsFilterBtn');
  if (userAdsFilterBtn) {
    userAdsFilterBtn.addEventListener('click', () => {
      if (currentUserId) {
        const startDate = document.getElementById('userAdsStartDate').value;
        const endDate = document.getElementById('userAdsEndDate').value;
        loadUserAds(currentUserId, 1, startDate, endDate);
      }
    });
  }
  
  // 用户商家汇总日期筛选
  const userSummaryFilterBtn = document.getElementById('userSummaryFilterBtn');
  if (userSummaryFilterBtn) {
    userSummaryFilterBtn.addEventListener('click', () => {
      if (currentUserId) {
        const startDate = document.getElementById('userSummaryStartDate').value;
        const endDate = document.getElementById('userSummaryEndDate').value;
        loadUserSummary(currentUserId, startDate, endDate);
      }
    });
  }
  
  // 创建用户按钮
  document.getElementById('createUserBtn').addEventListener('click', openCreateUserModal);
  
  // 关闭创建用户模态框
  document.getElementById('closeCreateUserModal').addEventListener('click', closeCreateUserModal);
  document.getElementById('cancelCreateUser').addEventListener('click', closeCreateUserModal);
  
  // 创建用户表单提交
  document.getElementById('createUserForm').addEventListener('submit', handleCreateUser);
  
  // 点击创建用户模态框外部关闭
  document.getElementById('createUserModal').addEventListener('click', (e) => {
    if (e.target.id === 'createUserModal') {
      closeCreateUserModal();
    }
  });

  // 关闭编辑用户模态框
  document.getElementById('closeEditUserModal').addEventListener('click', closeEditUserModal);
  document.getElementById('cancelEditUser').addEventListener('click', closeEditUserModal);
  
  // 编辑用户表单提交
  document.getElementById('editUserForm').addEventListener('submit', handleEditUser);
  
  // 点击编辑用户模态框外部关闭
  document.getElementById('editUserModal').addEventListener('click', (e) => {
    if (e.target.id === 'editUserModal') {
      closeEditUserModal();
    }
  });

  // 批量操作事件
  document.getElementById('selectAllUsers').addEventListener('change', handleSelectAllUsers);
  document.getElementById('batchApproveBtn').addEventListener('click', handleBatchApprove);
  document.getElementById('batchRejectBtn').addEventListener('click', handleBatchReject);
  document.getElementById('batchEnableBtn').addEventListener('click', handleBatchEnable);
  document.getElementById('batchDisableBtn').addEventListener('click', handleBatchDisable);
  document.getElementById('batchDeleteBtn').addEventListener('click', handleBatchDelete);
  document.getElementById('batchExportBtn').addEventListener('click', handleBatchExport);

  // 邀请码管理事件
  document.getElementById('generateInviteCodeBtn').addEventListener('click', () => {
    document.getElementById('generateInviteCodeModal').style.display = 'flex';
  });
  document.getElementById('generateInviteCodeForm').addEventListener('submit', handleGenerateInviteCode);

  // 用户统计分析事件
  document.getElementById('showUserAnalyticsBtn').addEventListener('click', () => {
    document.getElementById('userAnalyticsSection').style.display = 'block';
    loadUserAnalytics();
  });
  document.getElementById('hideAnalyticsBtn').addEventListener('click', () => {
    document.getElementById('userAnalyticsSection').style.display = 'none';
  });
  document.getElementById('refreshAnalyticsBtn').addEventListener('click', loadUserAnalytics);
  
  // 处理日期范围选择
  const analyticsPeriod = document.getElementById('analyticsPeriod');
  const analyticsDateRange = document.getElementById('analyticsDateRange');
  
  analyticsPeriod.addEventListener('change', (e) => {
    if (e.target.value === 'custom') {
      analyticsDateRange.style.display = 'flex';
      // 设置默认日期范围（最近30天）
      const endDate = new Date();
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - 30);
      document.getElementById('analyticsEndDate').value = endDate.toISOString().split('T')[0];
      document.getElementById('analyticsStartDate').value = startDate.toISOString().split('T')[0];
    } else {
      analyticsDateRange.style.display = 'none';
      loadUserAnalytics();
    }
  });
  
  // 商家分析筛选
  document.getElementById('merchantAnalysisFilterBtn').addEventListener('click', () => {
    const startDate = document.getElementById('merchantAnalysisStartDate').value;
    const endDate = document.getElementById('merchantAnalysisEndDate').value;
    loadMerchantAnalysis(startDate, endDate);
  });
  
  // 商家分析快速日期选择（只绑定平台统计页面内的按钮）
  document.querySelectorAll('#page-platform-stats .btn-quick-date').forEach(btn => {
    btn.addEventListener('click', (e) => {
      // 更新按钮激活状态
      document.querySelectorAll('#page-platform-stats .btn-quick-date').forEach(b => b.classList.remove('active'));
      e.target.classList.add('active');
      
      // 计算日期范围
      const { startDate, endDate } = calculateQuickDateRange(e.target.dataset.days, e.target.dataset.type);
      
      // 设置日期输入框
      document.getElementById('merchantAnalysisStartDate').value = startDate;
      document.getElementById('merchantAnalysisEndDate').value = endDate;
      
      // 自动加载数据
      loadMerchantAnalysis(startDate, endDate);
    });
  });
  
  // 商家分析搜索
  document.getElementById('merchantAnalysisSearchBtn').addEventListener('click', () => {
    filterMerchantAnalysis();
  });
  
  document.getElementById('merchantAnalysisSearch').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      filterMerchantAnalysis();
    }
  });
  
  // 商家分析清除搜索
  document.getElementById('merchantAnalysisClearBtn').addEventListener('click', () => {
    document.getElementById('merchantAnalysisSearch').value = '';
    filterMerchantAnalysis();
  });
  
  // 仪表板快捷卡片点击跳转
  document.querySelectorAll('.dashboard-shortcut-card').forEach(card => {
    card.addEventListener('click', () => {
      const page = card.dataset.page;
      switchPage(page);
    });
  });
}

// 切换页面
function switchPage(page) {
  currentPage = page;
  
  // 更新导航激活状态
  document.querySelectorAll('.nav-item').forEach(item => {
    if (item.dataset.page === page) {
      item.classList.add('active');
    } else {
      item.classList.remove('active');
    }
  });

  // 更新页面标题
  const titles = {
    'dashboard': '仪表板',
    'users': '用户管理',
    'platform-stats': '平台统计',
    'invitation-codes': '邀请码管理',
    'audit-logs': '审计日志',
    'data-collection': '数据采集',
    'withdrawal-management': '提现管理'
  };
  document.getElementById('pageTitle').textContent = titles[page] || '管理后台';

  // 隐藏所有页面
  document.querySelectorAll('.page-content').forEach(content => {
    content.classList.remove('active');
  });

  // 显示当前页面
  const targetPage = document.getElementById(`page-${page}`);
  if (targetPage) {
    targetPage.classList.add('active');
    // 重置滚动位置到页面顶部，避免显示在中间位置
    // 使用 requestAnimationFrame 确保在DOM渲染后执行
    requestAnimationFrame(() => {
      window.scrollTo({ top: 0, behavior: 'instant' });
      if (targetPage) {
        targetPage.scrollTop = 0;
      }
    });
  }

  // 加载页面数据
  switch (page) {
    case 'dashboard':
      // 仪表板只显示快捷操作，不需要加载数据
      break;
    case 'users':
      loadUsers();
      break;
    case 'platform-stats':
      // 设置默认日期
      const { startDate: psStartDate, endDate: psEndDate } = getDefaultDateRange();
      document.getElementById('statsStartDate').value = psStartDate;
      document.getElementById('statsEndDate').value = psEndDate;
      loadPlatformStats();
      
      // 设置商家分析默认日期（最近7天，不包含今天），但不自动加载
      // 让用户手动点击筛选按钮后再加载，避免页面跳转到商家分析部分
      const { startDate: maStartDate, endDate: maEndDate } = getDefaultDateRange();
      const merchantAnalysisStartDateEl = document.getElementById('merchantAnalysisStartDate');
      const merchantAnalysisEndDateEl = document.getElementById('merchantAnalysisEndDate');
      const merchantAnalysisContentEl = document.getElementById('merchantAnalysisContent');
      
      if (merchantAnalysisStartDateEl) {
        merchantAnalysisStartDateEl.value = maStartDate;
      }
      if (merchantAnalysisEndDateEl) {
        merchantAnalysisEndDateEl.value = maEndDate;
      }
      // 清除商家分析内容，显示提示信息
      if (merchantAnalysisContentEl) {
        merchantAnalysisContentEl.innerHTML = '<div class="loading" style="text-align: center; padding: 40px; color: var(--text-secondary);">选择日期范围后点击"筛选"按钮加载数据...</div>';
      }
      break;
    case 'invitation-codes':
      loadInvitationCodes();
      break;
    case 'audit-logs':
      loadAuditLogs();
      break;
    case 'data-collection':
      loadCollectionPage();
      break;
    case 'withdrawal-management':
      // 调用 admin-withdrawal.js 中的初始化函数
      if (typeof initWithdrawalManagement === 'function') {
        initWithdrawalManagement();
      }
      break;
  }
}

// 切换选项卡
function switchTab(tab) {
  // 更新按钮激活状态
  document.querySelectorAll('.tab-btn').forEach(btn => {
    if (btn.dataset.tab === tab) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });

  // 隐藏所有选项卡内容
  document.querySelectorAll('.tab-pane').forEach(pane => {
    pane.classList.remove('active');
  });

  // 显示当前选项卡
  const targetPane = document.getElementById(`tab-${tab}`);
  if (targetPane) {
    targetPane.classList.add('active');
  }

  // 加载选项卡数据
  if (currentUserId) {
    const { startDate, endDate } = getDefaultDateRange();
    
    switch (tab) {
      case 'accounts':
        loadUserAccounts(currentUserId);
        break;
      case 'orders':
        // 设置默认日期
        document.getElementById('userOrdersStartDate').value = startDate;
        document.getElementById('userOrdersEndDate').value = endDate;
        loadUserOrders(currentUserId, 1, startDate, endDate);
        break;
      case 'ads':
        // 设置默认日期
        document.getElementById('userAdsStartDate').value = startDate;
        document.getElementById('userAdsEndDate').value = endDate;
        loadUserAds(currentUserId, 1, startDate, endDate);
        break;
      case 'summary':
        // 设置默认日期
        document.getElementById('userSummaryStartDate').value = startDate;
        document.getElementById('userSummaryEndDate').value = endDate;
        loadUserSummary(currentUserId, startDate, endDate);
        break;
    }
  }
}

// 获取默认日期范围（最近7天，排除今天）
function getDefaultDateRange() {
  const today = new Date();
  const endDate = new Date(today);
  endDate.setDate(endDate.getDate() - 1); // 昨天（排除今天）
  const startDate = new Date(endDate);
  startDate.setDate(startDate.getDate() - 6); // 从昨天往前推6天，共7天
  
  return {
    startDate: startDate.toISOString().split('T')[0],
    endDate: endDate.toISOString().split('T')[0]
  };
}

// 生成分页按钮
function generatePaginationButtons(currentPage, totalPages, userId, startDate, endDate, type) {
  const buttons = [];
  const maxButtons = 5; // 最多显示5个页码按钮
  
  let startPage = Math.max(1, currentPage - Math.floor(maxButtons / 2));
  let endPage = Math.min(totalPages, startPage + maxButtons - 1);
  
  // 调整起始页
  if (endPage - startPage < maxButtons - 1) {
    startPage = Math.max(1, endPage - maxButtons + 1);
  }
  
  // 第一页
  if (startPage > 1) {
    buttons.push(`<button onclick="loadUser${type === 'ads' ? 'Ads' : 'Orders'}(${userId}, 1, '${startDate || ''}', '${endDate || ''}')">1</button>`);
    if (startPage > 2) {
      buttons.push('<span style="padding: 8px;">...</span>');
    }
  }
  
  // 中间页码
  for (let i = startPage; i <= endPage; i++) {
    const activeClass = i === currentPage ? 'active' : '';
    buttons.push(`<button class="${activeClass}" onclick="loadUser${type === 'ads' ? 'Ads' : 'Orders'}(${userId}, ${i}, '${startDate || ''}', '${endDate || ''}')">${i}</button>`);
  }
  
  // 最后一页
  if (endPage < totalPages) {
    if (endPage < totalPages - 1) {
      buttons.push('<span style="padding: 8px;">...</span>');
    }
    buttons.push(`<button onclick="loadUser${type === 'ads' ? 'Ads' : 'Orders'}(${userId}, ${totalPages}, '${startDate || ''}', '${endDate || ''}')">${totalPages}</button>`);
  }
  
  return buttons.join('');
}

// 更新时间显示
function updateTime() {
  const now = new Date();
  const timeStr = now.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
  document.getElementById('currentTime').textContent = timeStr;
}

// ========== 仪表板 ==========

async function loadDashboard() {
  try {
    console.log('📊 开始加载仪表板数据...');
    const response = await fetch(`${API_BASE}/api/super-admin/platform-stats`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    
    console.log('📊 仪表板API响应:', data);
    
    if (!data.success) {
      throw new Error(data.message || '加载失败');
    }

    const stats = data.data;
    console.log('📊 仪表板统计数据:', stats);

    // 更新统计卡片
    const totalUsersEl = document.getElementById('dashboardTotalUsers');
    const activeUsersEl = document.getElementById('dashboardActiveUsers');
    const totalOrdersEl = document.getElementById('dashboardTotalOrders');
    const confirmedCommissionEl = document.getElementById('dashboardConfirmedCommission');
    const totalCommissionEl = document.getElementById('dashboardTotalCommission');
    const pendingCommissionEl = document.getElementById('dashboardPendingCommission');
    const totalAdsCostEl = document.getElementById('dashboardTotalAdsCost');
    const totalImpressionsEl = document.getElementById('dashboardTotalImpressions');
    const profitEl = document.getElementById('dashboardProfit');
    const roiEl = document.getElementById('dashboardROI');
    const totalPlatformsEl = document.getElementById('dashboardTotalPlatforms');
    const platformLinkhaitaoEl = document.getElementById('dashboardPlatformLinkhaitao');
    const platformPMEl = document.getElementById('dashboardPlatformPM');
    const platformLBEl = document.getElementById('dashboardPlatformLB');
    const platformRWEl = document.getElementById('dashboardPlatformRW');

    if (totalUsersEl) {
      totalUsersEl.textContent = stats.users?.total || 0;
    }
    if (activeUsersEl) {
      activeUsersEl.textContent = stats.users?.active || 0;
    }
    if (totalOrdersEl) {
      totalOrdersEl.textContent = (stats.orders?.total || 0).toLocaleString();
    }
    if (confirmedCommissionEl) {
      confirmedCommissionEl.textContent = `$${(stats.orders?.confirmed_commission || 0).toFixed(2)}`;
    }
    if (totalCommissionEl) {
      totalCommissionEl.textContent = `$${(stats.orders?.total_commission || 0).toFixed(2)}`;
    }
    if (pendingCommissionEl) {
      pendingCommissionEl.textContent = `$${(stats.orders?.pending_commission || 0).toFixed(2)}`;
    }
    if (totalAdsCostEl) {
      totalAdsCostEl.textContent = `$${(stats.ads?.total_cost || 0).toFixed(2)}`;
    }
    if (totalImpressionsEl) {
      totalImpressionsEl.textContent = (stats.ads?.total_impressions || 0).toLocaleString();
    }
    if (profitEl) {
      // 如果没有profit字段，计算一下
      const profit = stats.roi?.profit !== undefined 
        ? stats.roi.profit 
        : ((stats.orders?.total_commission || 0) - (stats.ads?.total_cost || 0));
      profitEl.textContent = `$${profit.toFixed(2)}`;
      profitEl.style.color = profit >= 0 ? '#10b981' : '#ef4444';
    }
    if (roiEl) {
      const roi = stats.roi?.overall !== undefined 
        ? stats.roi.overall 
        : ((stats.ads?.total_cost || 0) > 0 
          ? ((stats.orders?.total_commission || 0) - (stats.ads?.total_cost || 0)) / (stats.ads.total_cost)
          : 0);
      roiEl.textContent = `${(roi * 100).toFixed(2)}%`;
      roiEl.style.color = roi >= 0 ? '#10b981' : '#ef4444';
    }
    if (totalPlatformsEl) {
      totalPlatformsEl.textContent = stats.platform_accounts?.total || 0;
    }
    if (platformLinkhaitaoEl) {
      platformLinkhaitaoEl.textContent = stats.platform_accounts?.by_platform?.linkhaitao || 0;
    }
    if (platformPMEl) {
      platformPMEl.textContent = stats.platform_accounts?.by_platform?.partnermatic || 0;
    }
    if (platformLBEl) {
      platformLBEl.textContent = stats.platform_accounts?.by_platform?.linkbux || 0;
    }
    if (platformRWEl) {
      platformRWEl.textContent = stats.platform_accounts?.by_platform?.rewardoo || 0;
    }

  } catch (error) {
    console.error('❌ 加载仪表板失败:', error);
    console.error('错误详情:', {
      message: error.message,
      stack: error.stack,
      response: error.response
    });
    
    // 显示错误提示
    const errorMsg = error.message || '加载失败';
    
    // 更新所有元素显示错误或默认值
    const elements = [
      'dashboardTotalUsers', 'dashboardActiveUsers', 'dashboardTotalOrders',
      'dashboardConfirmedCommission', 'dashboardTotalCommission', 'dashboardPendingCommission',
      'dashboardTotalAdsCost', 'dashboardTotalImpressions', 'dashboardProfit',
      'dashboardROI', 'dashboardTotalPlatforms', 'dashboardPlatformLinkhaitao',
      'dashboardPlatformPM', 'dashboardPlatformLB', 'dashboardPlatformRW'
    ];
    elements.forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        // 如果是数字字段，显示0而不是"-"
        if (id.includes('Users') || id.includes('Orders') || id.includes('Platforms') || id.includes('Impressions')) {
          el.textContent = '0';
        } else if (id.includes('Commission') || id.includes('Cost') || id.includes('Profit')) {
          el.textContent = '$0.00';
        } else if (id.includes('ROI')) {
          el.textContent = '0.00%';
        } else {
          el.textContent = '0';
        }
      } else {
        console.warn(`⚠️ 找不到元素: ${id}`);
      }
    });
    
    // 在页面上显示错误提示（可选）
    const dashboardContent = document.querySelector('#page-dashboard');
    if (dashboardContent) {
      let errorDiv = dashboardContent.querySelector('.dashboard-error');
      if (!errorDiv) {
        errorDiv = document.createElement('div');
        errorDiv.className = 'dashboard-error';
        errorDiv.style.cssText = 'padding: 16px; margin: 16px 0; background: rgba(239, 68, 68, 0.1); border: 1px solid #ef4444; border-radius: 8px; color: #ef4444;';
        dashboardContent.insertBefore(errorDiv, dashboardContent.firstChild);
      }
      errorDiv.textContent = `⚠️ 加载数据失败: ${errorMsg}。请检查网络连接或刷新页面重试。`;
    }
  }
}

// ========== 用户管理 ==========

async function loadUsers(page = 1, search = '') {
  try {
    const params = new URLSearchParams({ page, pageSize: 20, search });
    const response = await fetch(`${API_BASE}/api/super-admin/users?${params}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    const data = await response.json();
    
    if (!data.success) {
      throw new Error(data.message);
    }

    const { users, total, pageSize } = data.data;
    const tbody = document.getElementById('usersTableBody');
    
    if (users.length === 0) {
      tbody.innerHTML = '<tr><td colspan="11" class="loading">暂无数据</td></tr>';
      return;
    }

    tbody.innerHTML = users.map(user => {
      const statusHtml = user.is_active 
        ? '<span style="color: #4ade80; font-weight: 600;">● 启用</span>'
        : '<span style="color: #f87171; font-weight: 600;">● 禁用</span>';
      
      // 审核状态显示
      let approvalStatusHtml = '';
      if (user.approval_status === 'pending') {
        approvalStatusHtml = '<span style="color: #f59e0b; font-weight: 600;">⏳ 待审核</span>';
      } else if (user.approval_status === 'approved') {
        approvalStatusHtml = '<span style="color: #10b981; font-weight: 600;">✓ 已通过</span>';
      } else if (user.approval_status === 'rejected') {
        approvalStatusHtml = '<span style="color: #ef4444; font-weight: 600;">✗ 已拒绝</span>';
      } else {
        approvalStatusHtml = '<span style="color: #10b981; font-weight: 600;">✓ 已通过</span>'; // 兼容旧数据
      }

      // 审核按钮（仅对待审核用户显示）
      let approvalButtonsHtml = '';
      if (user.approval_status === 'pending') {
        approvalButtonsHtml = `
          <button class="btn-view" style="background: #10b981; margin-right: 5px;" onclick="approveUser(${user.id})">通过</button>
          <button class="btn-view" style="background: #ef4444; margin-right: 5px;" onclick="rejectUser(${user.id})">拒绝</button>
        `;
      }
      
      return `
      <tr data-user-id="${user.id}">
        <td>
          <input type="checkbox" class="user-checkbox" value="${user.id}" onchange="updateBatchActions()">
        </td>
        <td>${user.id}</td>
        <td>${user.username || '-'}</td>
        <td>${user.email}</td>
        <td>${statusHtml}</td>
        <td>${approvalStatusHtml}</td>
        <td>${new Date(user.created_at).toLocaleDateString('zh-CN')}</td>
        <td>${user.stats.account_count}</td>
        <td>${user.stats.order_count}</td>
        <td>$${user.stats.total_commission.toFixed(2)}</td>
        <td>
          ${approvalButtonsHtml}
          <button class="btn-view" onclick="viewUserDetail(${user.id})">查看</button>
          <button class="btn-edit" onclick="openEditUserModal(${user.id}, '${(user.username || '').replace(/'/g, "\\'")}', '${user.email}', ${user.is_active ? 1 : 0})">编辑</button>
          <button class="btn-delete" onclick="deleteUser(${user.id}, '${user.username || user.email}')">删除</button>
        </td>
      </tr>
    `;
    }).join('');

    // 渲染分页
    renderPagination('usersPagination', page, Math.ceil(total / pageSize), (p) => loadUsers(p, search));

  } catch (error) {
    console.error('加载用户列表失败:', error);
    document.getElementById('usersTableBody').innerHTML = 
      `<tr><td colspan="11" class="loading">加载失败: ${error.message}</td></tr>`;
  }
  
  // 重置批量选择
  document.getElementById('selectAllUsers').checked = false;
  updateBatchActions();
}

// 查看用户详情
async function viewUserDetail(userId) {
  // 立即更新 currentUserId，确保后续操作使用正确的用户ID
  currentUserId = userId;
  
  // 清除之前的数据显示，避免显示旧数据
  document.getElementById('userAccountsContent').innerHTML = '<div class="loading">加载中...</div>';
  document.getElementById('userOrdersContent').innerHTML = '<div class="loading">加载中...</div>';
  document.getElementById('userAdsContent').innerHTML = '<div class="loading">加载中...</div>';
  document.getElementById('userSummaryContent').innerHTML = '<div class="loading">加载中...</div>';
  
  // 显示用户详情页面
  document.querySelectorAll('.page-content').forEach(content => {
    content.classList.remove('active');
  });
  document.getElementById('page-user-detail').classList.add('active');

  try {
    const response = await fetch(`${API_BASE}/api/super-admin/users/${userId}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    const data = await response.json();
    
    if (!data.success) {
      throw new Error(data.message);
    }

    const { user, stats } = data.data;

    // 显示用户信息
    document.getElementById('userDetailInfo').innerHTML = `
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 20px 32px;">
        <div><strong>用户ID:</strong> ${user.id}</div>
        <div><strong>用户名:</strong> ${user.username}</div>
        <div><strong>邮箱:</strong> ${user.email}</div>
        <div><strong>注册时间:</strong> ${new Date(user.created_at).toLocaleString('zh-CN')}</div>
        <div><strong>平台账号数:</strong> ${stats.platform_accounts}</div>
        <div><strong>订单总数:</strong> ${stats.total_orders}</div>
        <div><strong>订单总额:</strong> $${stats.total_amount.toFixed(2)}</div>
        <div><strong>总佣金:</strong> $${stats.total_commission.toFixed(2)}</div>
        <div><strong>Google表格数:</strong> ${stats.google_sheets}</div>
        <div><strong>账号状态:</strong> ${user.is_active ? '✅ 活跃' : '❌ 未激活'}</div>
      </div>
    `;

    // 重置到第一个选项卡并加载数据
    switchTab('accounts');

  } catch (error) {
    console.error('加载用户详情失败:', error);
    document.getElementById('userDetailInfo').innerHTML = 
      `<div style="color: var(--danger-color);">加载失败: ${error.message}</div>`;
  }
}

// 加载用户平台账号
async function loadUserAccounts(userId) {
  try {
    const response = await fetch(`${API_BASE}/api/super-admin/users/${userId}/accounts`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    const data = await response.json();
    
    if (!data.success) {
      throw new Error(data.message);
    }

    const accounts = data.data;

    if (accounts.length === 0) {
      document.getElementById('userAccountsContent').innerHTML = '<p>暂无平台账号</p>';
      return;
    }

    document.getElementById('userAccountsContent').innerHTML = `
      <table class="data-table">
        <thead>
          <tr>
            <th>ID</th>
            <th>平台</th>
            <th>账号名称</th>
            <th>联盟名称</th>
            <th>状态</th>
            <th>创建时间</th>
          </tr>
        </thead>
        <tbody>
          ${accounts.map(acc => `
            <tr>
              <td>${acc.id}</td>
              <td>${acc.platform}</td>
              <td>${acc.account_name || '-'}</td>
              <td>${acc.affiliate_name || '-'}</td>
              <td>${acc.is_active ? '✅ 激活' : '❌ 未激活'}</td>
              <td>${new Date(acc.created_at).toLocaleString('zh-CN')}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;

  } catch (error) {
    console.error('加载用户平台账号失败:', error);
    document.getElementById('userAccountsContent').innerHTML = 
      `<div style="color: var(--danger-color);">加载失败: ${error.message}</div>`;
  }
}

// 加载用户订单
async function loadUserOrders(userId, page = 1, startDate = null, endDate = null) {
  try {
    const params = new URLSearchParams({ page, pageSize: 50 });
    if (startDate) params.append('startDate', startDate);
    if (endDate) params.append('endDate', endDate);
    
    const response = await fetch(`${API_BASE}/api/super-admin/users/${userId}/orders?${params}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    const data = await response.json();
    
    if (!data.success) {
      throw new Error(data.message);
    }

    const { orders, total } = data.data;

    if (orders.length === 0) {
      document.getElementById('userOrdersContent').innerHTML = '<p>暂无订单数据</p>';
      return;
    }

    const totalPages = Math.ceil(total / 50);
    
    document.getElementById('userOrdersContent').innerHTML = `
      <table class="data-table">
        <thead>
          <tr>
            <th>订单ID</th>
            <th>商家</th>
            <th>订单金额</th>
            <th>佣金</th>
            <th>状态</th>
            <th>订单日期</th>
          </tr>
        </thead>
        <tbody>
          ${orders.map(order => `
            <tr>
              <td>${order.order_id}</td>
              <td>${order.merchant_name || '-'}</td>
              <td>$${order.order_amount.toFixed(2)}</td>
              <td>$${order.commission.toFixed(2)}</td>
              <td>${order.status}</td>
              <td>${new Date(order.order_date).toLocaleDateString('zh-CN')}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      <div style="margin-top: 16px; text-align: center; color: var(--text-secondary);">
        共 ${total} 条订单，第 ${page}/${totalPages} 页
      </div>
      <div class="pagination" id="ordersDataPagination">
        <button ${page === 1 ? 'disabled' : ''} onclick="loadUserOrders(${userId}, ${page - 1}, '${startDate || ''}', '${endDate || ''}')">上一页</button>
        ${generatePaginationButtons(page, totalPages, userId, startDate, endDate, 'orders')}
        <button ${page === totalPages ? 'disabled' : ''} onclick="loadUserOrders(${userId}, ${page + 1}, '${startDate || ''}', '${endDate || ''}')">下一页</button>
      </div>
    `;

  } catch (error) {
    console.error('加载用户订单失败:', error);
    document.getElementById('userOrdersContent').innerHTML = 
      `<div style="color: var(--danger-color);">加载失败: ${error.message}</div>`;
  }
}

// 加载用户广告数据
async function loadUserAds(userId, page = 1, startDate = null, endDate = null) {
  try {
    const params = new URLSearchParams({ page, pageSize: 50 });
    if (startDate) params.append('startDate', startDate);
    if (endDate) params.append('endDate', endDate);
    
    const response = await fetch(`${API_BASE}/api/super-admin/users/${userId}/ads-data?${params}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    const data = await response.json();
    
    if (!data.success) {
      throw new Error(data.message);
    }

    const { adsData, total } = data.data;

    if (adsData.length === 0) {
      document.getElementById('userAdsContent').innerHTML = '<p>暂无广告数据</p>';
      return;
    }

    const totalPages = Math.ceil(total / 50);
    
    document.getElementById('userAdsContent').innerHTML = `
      <table class="data-table">
        <thead>
          <tr>
            <th>日期</th>
            <th>广告系列</th>
            <th>预算</th>
            <th>展示</th>
            <th>点击</th>
            <th>费用</th>
          </tr>
        </thead>
        <tbody>
          ${adsData.map(ad => `
            <tr>
              <td>${ad.date}</td>
              <td>${ad.campaign_name || '-'}</td>
              <td>${ad.campaign_budget} ${ad.currency}</td>
              <td>${ad.impressions}</td>
              <td>${ad.clicks}</td>
              <td>${ad.cost.toFixed(2)} ${ad.currency}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      <div style="margin-top: 16px; text-align: center; color: var(--text-secondary);">
        共 ${total} 条广告数据，第 ${page}/${totalPages} 页
      </div>
      <div class="pagination" id="adsDataPagination">
        <button ${page === 1 ? 'disabled' : ''} onclick="loadUserAds(${userId}, ${page - 1}, '${startDate || ''}', '${endDate || ''}')">上一页</button>
        ${generatePaginationButtons(page, totalPages, userId, startDate, endDate, 'ads')}
        <button ${page === totalPages ? 'disabled' : ''} onclick="loadUserAds(${userId}, ${page + 1}, '${startDate || ''}', '${endDate || ''}')">下一页</button>
      </div>
    `;

  } catch (error) {
    console.error('加载用户广告数据失败:', error);
    document.getElementById('userAdsContent').innerHTML = 
      `<div style="color: var(--danger-color);">加载失败: ${error.message}</div>`;
  }
}

// 加载用户商家汇总
async function loadUserSummary(userId, startDate = null, endDate = null) {
  try {
    const params = new URLSearchParams();
    if (startDate) params.append('startDate', startDate);
    if (endDate) params.append('endDate', endDate);
    
    const queryString = params.toString();
    const url = `${API_BASE}/api/super-admin/users/${userId}/summary${queryString ? '?' + queryString : ''}`;
    
    const response = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    const data = await response.json();
    
    if (!data.success) {
      throw new Error(data.message);
    }

    let summary = data.data;

    if (summary.length === 0) {
      document.getElementById('userSummaryContent').innerHTML = '<p>暂无商家汇总数据</p>';
      return;
    }

    // 计算整体统计数据
    const totalStats = summary.reduce((acc, item) => {
      acc.totalBudget += item.total_budget || 0;
      acc.totalImpressions += item.total_impressions || 0;
      acc.totalClicks += item.total_clicks || 0;
      acc.totalCost += item.total_cost || 0;
      acc.totalOrders += item.order_count || 0;
      acc.totalCommission += item.total_commission || 0;
      return acc;
    }, {
      totalBudget: 0,
      totalImpressions: 0,
      totalClicks: 0,
      totalCost: 0,
      totalOrders: 0,
      totalCommission: 0
    });
    
    // 计算整体营销指标
    const overallCR = totalStats.totalClicks > 0 ? (totalStats.totalOrders / totalStats.totalClicks * 100).toFixed(2) : '0.00';
    const overallEPC = totalStats.totalClicks > 0 ? (totalStats.totalCommission / totalStats.totalClicks).toFixed(2) : '0.00';
    const overallCPC = totalStats.totalClicks > 0 ? (totalStats.totalCost / totalStats.totalClicks).toFixed(2) : '0.00';
    const overallROI = totalStats.totalCost > 0 ? ((totalStats.totalCommission - totalStats.totalCost) / totalStats.totalCost).toFixed(2) : '0.00';
    
    // 按ROI降序排序
    summary.sort((a, b) => {
      const roiA = a.total_cost > 0 ? (a.total_commission - a.total_cost) / a.total_cost : 0;
      const roiB = b.total_cost > 0 ? (b.total_commission - b.total_cost) / b.total_cost : 0;
      return roiB - roiA; // 降序：ROI高的在前
    });

    document.getElementById('userSummaryContent').innerHTML = `
      <div style="margin-bottom: 24px; padding: 20px; background: var(--card-bg); border-radius: 12px; border: 1px solid var(--border-color);">
        <h3 style="margin-bottom: 16px; color: var(--text-primary);">📊 整体数据汇总</h3>
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 20px;">
          <div>
            <div style="font-size: 12px; color: var(--text-secondary); margin-bottom: 4px;">总预算</div>
            <div style="font-size: 20px; font-weight: 600; color: var(--primary-color);">$${totalStats.totalBudget.toFixed(2)}</div>
          </div>
          <div>
            <div style="font-size: 12px; color: var(--text-secondary); margin-bottom: 4px;">总展示</div>
            <div style="font-size: 20px; font-weight: 600; color: var(--primary-color);">${totalStats.totalImpressions.toLocaleString()}</div>
          </div>
          <div>
            <div style="font-size: 12px; color: var(--text-secondary); margin-bottom: 4px;">总点击</div>
            <div style="font-size: 20px; font-weight: 600; color: var(--primary-color);">${totalStats.totalClicks.toLocaleString()}</div>
          </div>
          <div>
            <div style="font-size: 12px; color: var(--text-secondary); margin-bottom: 4px;">总广告费</div>
            <div style="font-size: 20px; font-weight: 600; color: var(--danger-color);">$${totalStats.totalCost.toFixed(2)}</div>
          </div>
          <div>
            <div style="font-size: 12px; color: var(--text-secondary); margin-bottom: 4px;">总订单数</div>
            <div style="font-size: 20px; font-weight: 600; color: var(--text-primary);">${totalStats.totalOrders}</div>
          </div>
          <div>
            <div style="font-size: 12px; color: var(--text-secondary); margin-bottom: 4px;">总佣金</div>
            <div style="font-size: 20px; font-weight: 600; color: var(--secondary-color);">$${totalStats.totalCommission.toFixed(2)}</div>
          </div>
          <div>
            <div style="font-size: 12px; color: var(--text-secondary); margin-bottom: 4px;">整体CR</div>
            <div style="font-size: 20px; font-weight: 600; color: var(--secondary-color);">${overallCR}%</div>
          </div>
          <div>
            <div style="font-size: 12px; color: var(--text-secondary); margin-bottom: 4px;">整体EPC</div>
            <div style="font-size: 20px; font-weight: 600; color: var(--secondary-color);">$${overallEPC}</div>
          </div>
          <div>
            <div style="font-size: 12px; color: var(--text-secondary); margin-bottom: 4px;">整体CPC</div>
            <div style="font-size: 20px; font-weight: 600; color: var(--secondary-color);">$${overallCPC}</div>
          </div>
          <div style="background: ${parseFloat(overallROI) >= 0 ? 'rgba(34, 197, 94, 0.1)' : 'rgba(239, 68, 68, 0.1)'}; padding: 12px; border-radius: 8px;">
            <div style="font-size: 12px; color: var(--text-secondary); margin-bottom: 4px;">🎯 整体ROI</div>
            <div style="font-size: 24px; font-weight: 700; color: ${parseFloat(overallROI) >= 0 ? 'var(--secondary-color)' : 'var(--danger-color)'};">${overallROI}</div>
          </div>
        </div>
      </div>
      <table class="data-table">
        <thead>
          <tr>
            <th>排名</th>
            <th>广告系列</th>
            <th>商家ID</th>
            <th>预算</th>
            <th>展示</th>
            <th>点击</th>
            <th>广告费</th>
            <th>订单数</th>
            <th>总佣金</th>
            <th>CR</th>
            <th>EPC</th>
            <th>CPC</th>
            <th>ROI</th>
          </tr>
        </thead>
        <tbody>
          ${summary.map((item, index) => {
            const clicks = item.total_clicks || 0;
            const orders = item.order_count || 0;
            const commission = item.total_commission || 0;
            const cost = item.total_cost || 0;
            
            // CR (Conversion Rate) = 订单数 / 点击数 * 100%
            const cr = clicks > 0 ? (orders / clicks * 100).toFixed(2) : '0.00';
            
            // EPC (Earnings Per Click) = 总佣金 / 点击数
            const epc = clicks > 0 ? (commission / clicks).toFixed(2) : '0.00';
            
            // CPC (Cost Per Click) = 广告费 / 点击数
            const cpc = clicks > 0 ? (cost / clicks).toFixed(2) : '0.00';
            
            // ROI (Return On Investment) = (总佣金 - 广告费) / 广告费
            let roi = '0.00';
            if (cost > 0) {
              roi = ((commission - cost) / cost).toFixed(2);
            }
            
            return `
            <tr>
              <td style="color: var(--text-secondary);">${index + 1}</td>
              <td style="font-size: 12px; max-width: 300px; word-wrap: break-word; white-space: normal; line-height: 1.4;" title="${item.campaign_names || '-'}">${item.campaign_names || '-'}</td>
              <td><strong style="color: var(--warning-color);">${item.merchant_id || '-'}</strong></td>
              <td style="color: var(--primary-color);">$${(item.total_budget || 0).toFixed(2)}</td>
              <td style="color: var(--primary-color);">${(item.total_impressions || 0).toLocaleString()}</td>
              <td style="color: var(--primary-color);">${clicks.toLocaleString()}</td>
              <td><strong style="color: var(--danger-color);">$${cost.toFixed(2)}</strong></td>
              <td>${orders}</td>
              <td><strong style="color: var(--secondary-color);">$${commission.toFixed(2)}</strong></td>
              <td><strong style="color: var(--secondary-color);">${cr}%</strong></td>
              <td><strong style="color: var(--secondary-color);">$${epc}</strong></td>
              <td><strong style="color: var(--secondary-color);">$${cpc}</strong></td>
              <td><strong style="color: ${parseFloat(roi) >= 0 ? 'var(--secondary-color)' : 'var(--danger-color)'};">${roi}</strong></td>
            </tr>
          `}).join('')}
        </tbody>
      </table>
    `;

    // 显示导出按钮
    document.getElementById('exportUserSummaryBtn').style.display = 'inline-flex';

  } catch (error) {
    console.error('加载用户商家汇总失败:', error);
    document.getElementById('userSummaryContent').innerHTML = 
      `<div style="color: var(--danger-color);">加载失败: ${error.message}</div>`;
    // 隐藏导出按钮
    document.getElementById('exportUserSummaryBtn').style.display = 'none';
  }
}

// ========== 平台统计 ==========

async function loadPlatformStats() {
  const refreshBtn = document.getElementById('statsRefreshBtn');
  const statsContent = document.getElementById('platformStatsContent');
  const originalBtnText = refreshBtn ? refreshBtn.innerHTML : '';
  
  try {
    const startDate = document.getElementById('statsStartDate').value;
    const endDate = document.getElementById('statsEndDate').value;
    
    // 显示加载状态
    if (refreshBtn) {
      refreshBtn.disabled = true;
      refreshBtn.innerHTML = '<span>⏳</span> 刷新中...';
      refreshBtn.style.opacity = '0.7';
      refreshBtn.style.cursor = 'not-allowed';
    }
    
    // 显示数据加载提示
    if (statsContent) {
      statsContent.innerHTML = '<div class="loading" style="text-align: center; padding: 40px; color: var(--text-secondary);">⏳ 正在加载数据...</div>';
    }
    
    const params = new URLSearchParams();
    if (startDate) params.append('startDate', startDate);
    if (endDate) params.append('endDate', endDate);

    const response = await fetch(`${API_BASE}/api/super-admin/platform-stats?${params}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    const data = await response.json();
    
    if (!data.success) {
      throw new Error(data.message);
    }

    const stats = data.data;

    document.getElementById('platformStatsContent').innerHTML = `
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-icon">👥</div>
          <div class="stat-info">
            <div class="stat-value">${stats.users.total}</div>
            <div class="stat-label">总用户数</div>
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-icon">✅</div>
          <div class="stat-info">
            <div class="stat-value">${stats.users.active}</div>
            <div class="stat-label">活跃用户</div>
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-icon">🆕</div>
          <div class="stat-info">
            <div class="stat-value">${stats.users.new_this_month}</div>
            <div class="stat-label">本月新增</div>
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-icon">🔗</div>
          <div class="stat-info">
            <div class="stat-value">${stats.platform_accounts.total}</div>
            <div class="stat-label">平台账号总数</div>
          </div>
        </div>
      </div>

      <div class="section-title">订单统计</div>
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-icon">📦</div>
          <div class="stat-info">
            <div class="stat-value">${stats.orders.total}</div>
            <div class="stat-label">总订单数</div>
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-icon">💵</div>
          <div class="stat-info">
            <div class="stat-value">$${stats.orders.total_amount.toFixed(2)}</div>
            <div class="stat-label">订单总额</div>
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-icon">💰</div>
          <div class="stat-info">
            <div class="stat-value">$${stats.orders.total_commission.toFixed(2)}</div>
            <div class="stat-label">总佣金</div>
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-icon">✔️</div>
          <div class="stat-info">
            <div class="stat-value">$${stats.orders.confirmed_commission.toFixed(2)}</div>
            <div class="stat-label">已确认佣金</div>
          </div>
        </div>
      </div>

      <div class="section-title">广告统计</div>
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-icon">💸</div>
          <div class="stat-info">
            <div class="stat-value">$${stats.ads.total_cost.toFixed(2)}</div>
            <div class="stat-label">总广告费</div>
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-icon">👁️</div>
          <div class="stat-info">
            <div class="stat-value">${stats.ads.total_impressions.toLocaleString()}</div>
            <div class="stat-label">总展示次数</div>
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-icon">👆</div>
          <div class="stat-info">
            <div class="stat-value">${stats.ads.total_clicks.toLocaleString()}</div>
            <div class="stat-label">总点击次数</div>
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-icon">📊</div>
          <div class="stat-info">
            <div class="stat-value" style="color: ${stats.roi.overall >= 0 ? 'var(--secondary-color)' : 'var(--danger-color)'}">
              ${stats.roi.overall.toFixed(2)}
            </div>
            <div class="stat-label">整体ROI</div>
            <div style="font-size: 11px; color: var(--text-secondary); margin-top: 4px;">
              (佣金-广告费)/广告费
            </div>
          </div>
        </div>
      </div>

      <div class="section-title">收益分析</div>
      <div class="platform-distribution">
        <div class="platform-item">
          <span class="platform-name">总佣金收入</span>
          <span class="platform-count">$${stats.orders.total_commission.toFixed(2)}</span>
        </div>
        <div class="platform-item">
          <span class="platform-name">总广告支出</span>
          <span class="platform-count">$${stats.ads.total_cost.toFixed(2)}</span>
        </div>
        <div class="platform-item">
          <span class="platform-name">净利润</span>
          <span class="platform-count" style="color: ${stats.roi.profit >= 0 ? 'var(--secondary-color)' : 'var(--danger-color)'}">
            $${stats.roi.profit.toFixed(2)}
          </span>
        </div>
      </div>
    `;

    // 恢复按钮状态
    if (refreshBtn) {
      refreshBtn.disabled = false;
      refreshBtn.innerHTML = originalBtnText || '刷新';
      refreshBtn.style.opacity = '1';
      refreshBtn.style.cursor = 'pointer';
    }

  } catch (error) {
    console.error('加载平台统计失败:', error);
    if (statsContent) {
      statsContent.innerHTML = 
        `<div style="color: var(--danger-color); padding: 40px; text-align: center;">❌ 加载失败: ${error.message}</div>`;
    }
    
    // 恢复按钮状态
    if (refreshBtn) {
      refreshBtn.disabled = false;
      refreshBtn.innerHTML = originalBtnText || '刷新';
      refreshBtn.style.opacity = '1';
      refreshBtn.style.cursor = 'pointer';
    }
  }
}

// ========== 审计日志 ==========

async function loadAuditLogs(page = 1) {
  try {
    const action = document.getElementById('logActionFilter').value;
    const startDate = document.getElementById('logStartDate').value;
    const endDate = document.getElementById('logEndDate').value;
    
    const params = new URLSearchParams({ page, pageSize: 50 });
    if (action) params.append('action', action);
    if (startDate) params.append('startDate', startDate);
    if (endDate) params.append('endDate', endDate);

    const response = await fetch(`${API_BASE}/api/super-admin/audit-logs?${params}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    const data = await response.json();
    
    if (!data.success) {
      throw new Error(data.message);
    }

    const { logs, total, pageSize } = data.data;
    const tbody = document.getElementById('auditLogsTableBody');
    
    if (logs.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="loading">暂无审计日志</td></tr>';
      return;
    }

    tbody.innerHTML = logs.map(log => `
      <tr>
        <td>${new Date(log.created_at).toLocaleString('zh-CN')}</td>
        <td>${log.admin_username}</td>
        <td>${log.action}</td>
        <td>${log.target_username || '-'}</td>
        <td>${log.ip_address || '-'}</td>
        <td>${log.execution_time || 0}ms</td>
      </tr>
    `).join('');

    // 渲染分页
    renderPagination('logsPagination', page, Math.ceil(total / pageSize), loadAuditLogs);

  } catch (error) {
    console.error('加载审计日志失败:', error);
    document.getElementById('auditLogsTableBody').innerHTML = 
      `<tr><td colspan="6" class="loading">加载失败: ${error.message}</td></tr>`;
  }
}

// ========== 通用函数 ==========

// 渲染分页
function renderPagination(containerId, currentPage, totalPages, onPageChange) {
  const container = document.getElementById(containerId);
  if (!container) return;

  let html = '';

  // 上一页
  html += `<button ${currentPage === 1 ? 'disabled' : ''} onclick="(${onPageChange})(${currentPage - 1})">上一页</button>`;

  // 页码
  const maxPages = 5;
  let startPage = Math.max(1, currentPage - Math.floor(maxPages / 2));
  let endPage = Math.min(totalPages, startPage + maxPages - 1);

  if (endPage - startPage < maxPages - 1) {
    startPage = Math.max(1, endPage - maxPages + 1);
  }

  if (startPage > 1) {
    html += `<button onclick="(${onPageChange})(1)">1</button>`;
    if (startPage > 2) {
      html += `<button disabled>...</button>`;
    }
  }

  for (let i = startPage; i <= endPage; i++) {
    html += `<button class="${i === currentPage ? 'active' : ''}" onclick="(${onPageChange})(${i})">${i}</button>`;
  }

  if (endPage < totalPages) {
    if (endPage < totalPages - 1) {
      html += `<button disabled>...</button>`;
    }
    html += `<button onclick="(${onPageChange})(${totalPages})">${totalPages}</button>`;
  }

  // 下一页
  html += `<button ${currentPage === totalPages ? 'disabled' : ''} onclick="(${onPageChange})(${currentPage + 1})">下一页</button>`;

  container.innerHTML = html;
}

// ========== 用户管理功能 ==========

// 打开创建用户模态框
function openCreateUserModal() {
  document.getElementById('createUserModal').classList.add('active');
  document.getElementById('createUserForm').reset();
  document.getElementById('createUserMessage').className = 'message';
  document.getElementById('createUserMessage').textContent = '';
}

// 关闭创建用户模态框
function closeCreateUserModal() {
  document.getElementById('createUserModal').classList.remove('active');
}

// 处理创建用户
async function handleCreateUser(e) {
  e.preventDefault();
  
  const email = document.getElementById('newUserEmail').value;
  const username = document.getElementById('newUserUsername').value;
  const password = document.getElementById('newUserPassword').value;
  const role = document.getElementById('newUserRole').value;
  
  // 简单验证
  if (password.length < 6) {
    showModalMessage('createUserMessage', '密码至少需要6位', 'error');
    return;
  }
  
  try {
    const response = await fetch(`${API_BASE}/api/super-admin/users`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ email, username, password, role })
    });
    
    const data = await response.json();
    
    if (data.success) {
      showModalMessage('createUserMessage', '用户创建成功！', 'success');
      setTimeout(() => {
        closeCreateUserModal();
        loadUsers(); // 重新加载用户列表
      }, 1500);
    } else {
      showModalMessage('createUserMessage', data.message, 'error');
    }
  } catch (error) {
    console.error('创建用户失败:', error);
    showModalMessage('createUserMessage', '创建失败: ' + error.message, 'error');
  }
}

// 打开编辑用户模态框
function openEditUserModal(userId, username, email, isActive) {
  // 填充表单数据
  document.getElementById('editUserId').value = userId;
  document.getElementById('editUserUsername').value = username || '';
  document.getElementById('editUserEmail').value = email || '';
  document.getElementById('editUserPassword').value = '';
  document.getElementById('editUserIsActive').value = isActive ? '1' : '0';
  
  // 清空消息
  document.getElementById('editUserMessage').className = 'message';
  document.getElementById('editUserMessage').textContent = '';
  
  // 显示模态框
  document.getElementById('editUserModal').classList.add('active');
}

// 关闭编辑用户模态框
function closeEditUserModal() {
  document.getElementById('editUserModal').classList.remove('active');
  document.getElementById('editUserForm').reset();
}

// 处理编辑用户
async function handleEditUser(e) {
  e.preventDefault();
  
  const userId = document.getElementById('editUserId').value;
  const username = document.getElementById('editUserUsername').value.trim();
  const email = document.getElementById('editUserEmail').value.trim();
  const password = document.getElementById('editUserPassword').value;
  const isActive = document.getElementById('editUserIsActive').value === '1';
  
  // 构建更新数据（只包含有值的字段）
  const updateData = {};
  if (username !== '') {
    updateData.username = username;
  }
  if (email !== '') {
    updateData.email = email;
  }
  if (password !== '') {
    if (password.length < 6) {
      showModalMessage('editUserMessage', '密码至少需要6位', 'error');
      return;
    }
    updateData.password = password;
  }
  updateData.is_active = isActive;
  
  try {
    const response = await fetch(`${API_BASE}/api/super-admin/users/${userId}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(updateData)
    });
    
    const data = await response.json();
    
    if (data.success) {
      showModalMessage('editUserMessage', '用户信息更新成功！', 'success');
      setTimeout(() => {
        closeEditUserModal();
        loadUsers(); // 重新加载用户列表
      }, 1500);
    } else {
      showModalMessage('editUserMessage', data.message, 'error');
    }
  } catch (error) {
    console.error('更新用户信息失败:', error);
    showModalMessage('editUserMessage', '更新失败: ' + error.message, 'error');
  }
}

// 删除用户
async function deleteUser(userId, username) {
  if (!confirm(`确定要删除用户 "${username}" 吗？\n\n此操作将删除该用户的所有数据（平台账号、订单、广告数据），且不可恢复！`)) {
    return;
  }
  
  try {
    const response = await fetch(`${API_BASE}/api/super-admin/users/${userId}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });
    
    const data = await response.json();
    
    if (data.success) {
      alert('用户删除成功！');
      loadUsers(); // 重新加载用户列表
    } else {
      alert('删除失败: ' + data.message);
    }
  } catch (error) {
    console.error('删除用户失败:', error);
    alert('删除失败: ' + error.message);
  }
}

// 显示模态框消息
function showModalMessage(elementId, message, type) {
  const msgElement = document.getElementById(elementId);
  msgElement.textContent = message;
  msgElement.className = `message ${type}`;
}

// 更新批量操作工具栏（全局函数，供HTML调用）
window.updateBatchActions = function() {
  const checkboxes = document.querySelectorAll('.user-checkbox:checked');
  const selectedCount = checkboxes.length;
  const batchActions = document.getElementById('batchActions');
  const selectedCountEl = document.getElementById('selectedCount');
  
  if (selectedCount > 0) {
    batchActions.style.display = 'flex';
    selectedCountEl.textContent = `已选择 ${selectedCount} 项`;
  } else {
    batchActions.style.display = 'none';
    selectedCountEl.textContent = '已选择 0 项';
  }
  
  // 更新全选复选框状态
  const allCheckboxes = document.querySelectorAll('.user-checkbox');
  const selectAllCheckbox = document.getElementById('selectAllUsers');
  if (allCheckboxes.length > 0) {
    selectAllCheckbox.checked = checkboxes.length === allCheckboxes.length;
    selectAllCheckbox.indeterminate = checkboxes.length > 0 && checkboxes.length < allCheckboxes.length;
  }
};

// 全选/取消全选
function handleSelectAllUsers(e) {
  const checkboxes = document.querySelectorAll('.user-checkbox');
  checkboxes.forEach(checkbox => {
    checkbox.checked = e.target.checked;
  });
  updateBatchActions();
}

// 获取选中的用户ID列表
function getSelectedUserIds() {
  const checkboxes = document.querySelectorAll('.user-checkbox:checked');
  return Array.from(checkboxes).map(cb => parseInt(cb.value));
}

// 批量启用
async function handleBatchEnable() {
  const userIds = getSelectedUserIds();
  if (userIds.length === 0) {
    alert('请先选择要操作的用户');
    return;
  }
  
  if (!confirm(`确定要启用 ${userIds.length} 个用户吗？`)) {
    return;
  }
  
  try {
    const response = await fetch(`${API_BASE}/api/super-admin/users/batch-update`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        user_ids: userIds,
        action: 'enable'
      })
    });
    
    const data = await response.json();
    
    if (data.success) {
      alert(`成功启用 ${data.data.success_count} 个用户`);
      loadUsers();
    } else {
      alert('批量启用失败: ' + data.message);
    }
  } catch (error) {
    console.error('批量启用失败:', error);
    alert('批量启用失败: ' + error.message);
  }
}

// 批量禁用
async function handleBatchDisable() {
  const userIds = getSelectedUserIds();
  if (userIds.length === 0) {
    alert('请先选择要操作的用户');
    return;
  }
  
  if (!confirm(`确定要禁用 ${userIds.length} 个用户吗？禁用后用户将无法登录。`)) {
    return;
  }
  
  try {
    const response = await fetch(`${API_BASE}/api/super-admin/users/batch-update`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        user_ids: userIds,
        action: 'disable'
      })
    });
    
    const data = await response.json();
    
    if (data.success) {
      alert(`成功禁用 ${data.data.success_count} 个用户`);
      loadUsers();
    } else {
      alert('批量禁用失败: ' + data.message);
    }
  } catch (error) {
    console.error('批量禁用失败:', error);
    alert('批量禁用失败: ' + error.message);
  }
}

// 批量删除
async function handleBatchDelete() {
  const userIds = getSelectedUserIds();
  if (userIds.length === 0) {
    alert('请先选择要删除的用户');
    return;
  }
  
  if (!confirm(`⚠️ 警告：确定要删除 ${userIds.length} 个用户吗？\n\n此操作将删除这些用户的所有数据（平台账号、订单、广告数据），且不可恢复！`)) {
    return;
  }
  
  try {
    const response = await fetch(`${API_BASE}/api/super-admin/users/batch-delete`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        user_ids: userIds
      })
    });
    
    const data = await response.json();
    
    if (data.success) {
      alert(`成功删除 ${data.data.success_count} 个用户`);
      loadUsers();
    } else {
      alert('批量删除失败: ' + data.message);
    }
  } catch (error) {
    console.error('批量删除失败:', error);
    alert('批量删除失败: ' + error.message);
  }
}

// 加载用户统计分析
async function loadUserAnalytics() {
  try {
    const period = document.getElementById('analyticsPeriod').value;
    let url = `${API_BASE}/api/super-admin/users/analytics?period=${period}`;
    
    // 如果是自定义日期，添加日期参数
    if (period === 'custom') {
      const startDate = document.getElementById('analyticsStartDate').value;
      const endDate = document.getElementById('analyticsEndDate').value;
      
      if (!startDate || !endDate) {
        alert('请选择开始日期和结束日期');
        return;
      }
      
      if (new Date(startDate) > new Date(endDate)) {
        alert('开始日期不能晚于结束日期');
        return;
      }
      
      url += `&startDate=${startDate}&endDate=${endDate}`;
    }
    
    document.getElementById('periodDays').textContent = period;

    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    const data = await response.json();
    
    if (!data.success) {
      throw new Error(data.message);
    }

    const analytics = data.data;

    // 更新统计卡片
    document.getElementById('totalUsersStat').textContent = analytics.active_stats.total_users;
    document.getElementById('activeUsersStat').textContent = analytics.active_stats.active_users;
    document.getElementById('inactiveUsersStat').textContent = analytics.active_stats.inactive_users;
    document.getElementById('newUsersStat').textContent = analytics.active_stats.new_users;
    document.getElementById('usersWithOrdersStat').textContent = analytics.activity_analysis.users_with_orders;
    document.getElementById('usersWithAccountsStat').textContent = analytics.activity_analysis.users_with_accounts;
    document.getElementById('activeLast30DaysStat').textContent = analytics.activity_analysis.active_last_30_days;

    // 渲染贡献度排行
    renderContributionRanking(analytics.contribution_ranking);

  } catch (error) {
    console.error('加载用户统计分析失败:', error);
    alert('加载失败: ' + error.message);
  }
}

// 渲染贡献度排行
function renderContributionRanking(ranking) {
  const tbody = document.getElementById('contributionRankingBody');
  
  if (!ranking || ranking.length === 0) {
    tbody.innerHTML = '<tr><td colspan="11" class="loading">暂无数据</td></tr>';
    return;
  }

  tbody.innerHTML = ranking.map((user, index) => {
    const rank = index + 1;
    const rankBadge = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : rank;
    const statusHtml = user.is_active 
      ? '<span style="color: #4ade80;">● 启用</span>'
      : '<span style="color: #f87171;">● 禁用</span>';
    
    // ROI颜色：正数绿色，负数红色，0灰色
    // ROI是小数形式（如 0.25 表示 25%），不显示百分号，与系统其他地方保持一致
    const roiValue = user.stats.roi || 0;
    const roiColor = roiValue >= 0 ? '#4ade80' : '#f87171';
    const roiText = roiValue.toFixed(2);
    
    return `
      <tr>
        <td style="font-weight: 600; color: var(--primary-color);">${rankBadge}</td>
        <td>${user.username || '-'}</td>
        <td>${user.email}</td>
        <td>${user.stats.account_count}</td>
        <td>${user.stats.order_count}</td>
        <td style="font-weight: 600;">$${user.stats.total_amount.toFixed(2)}</td>
        <td style="font-weight: 600; color: #10b981;">$${user.stats.total_commission.toFixed(2)}</td>
        <td style="font-weight: 600; color: #f87171;">$${(user.stats.total_cost || 0).toFixed(2)}</td>
        <td style="font-weight: 700; color: ${roiColor}; font-size: 13px;">${roiText}</td>
        <td>${statusHtml}</td>
        <td>
          <button class="btn-view" onclick="viewUserDetail(${user.id})">查看</button>
        </td>
      </tr>
    `;
  }).join('');
}

// 批量导出
async function handleBatchExport() {
  const userIds = getSelectedUserIds();
  if (userIds.length === 0) {
    alert('请先选择要导出的用户');
    return;
  }
  
  try {
    const response = await fetch(`${API_BASE}/api/super-admin/users/batch-export`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        user_ids: userIds
      })
    });
    
    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.message || '导出失败');
    }
    
    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `用户数据导出_${new Date().toISOString().split('T')[0]}.xlsx`;
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(url);
    document.body.removeChild(a);
    
    alert(`成功导出 ${userIds.length} 个用户的数据`);
  } catch (error) {
    console.error('批量导出失败:', error);
    alert('批量导出失败: ' + error.message);
  }
}

// 审核通过用户
async function approveUser(userId) {
  if (!confirm('确定要通过该用户的审核吗？')) {
    return;
  }
  
  try {
    const response = await fetch(`${API_BASE}/api/super-admin/users/${userId}/approve`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    
    const data = await response.json();
    
    if (data.success) {
      alert('用户审核已通过');
      loadUsers();
    } else {
      alert('审核失败: ' + data.message);
    }
  } catch (error) {
    console.error('审核失败:', error);
    alert('审核失败: ' + error.message);
  }
}

// 审核拒绝用户
async function rejectUser(userId) {
  if (!confirm('确定要拒绝该用户的审核吗？')) {
    return;
  }
  
  try {
    const response = await fetch(`${API_BASE}/api/super-admin/users/${userId}/reject`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    
    const data = await response.json();
    
    if (data.success) {
      alert('用户审核已拒绝');
      loadUsers();
    } else {
      alert('审核失败: ' + data.message);
    }
  } catch (error) {
    console.error('审核失败:', error);
    alert('审核失败: ' + error.message);
  }
}

// 批量审核通过
async function handleBatchApprove() {
  const userIds = getSelectedUserIds();
  if (userIds.length === 0) {
    alert('请先选择要审核的用户');
    return;
  }
  
  if (!confirm(`确定要通过 ${userIds.length} 个用户的审核吗？`)) {
    return;
  }
  
  try {
    const response = await fetch(`${API_BASE}/api/super-admin/users/batch-approve`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        user_ids: userIds,
        action: 'approve'
      })
    });
    
    const data = await response.json();
    
    if (data.success) {
      alert(`成功通过 ${data.data.success_count} 个用户的审核`);
      loadUsers();
    } else {
      alert('批量审核失败: ' + data.message);
    }
  } catch (error) {
    console.error('批量审核失败:', error);
    alert('批量审核失败: ' + error.message);
  }
}

// 批量审核拒绝
async function handleBatchReject() {
  const userIds = getSelectedUserIds();
  if (userIds.length === 0) {
    alert('请先选择要审核的用户');
    return;
  }
  
  if (!confirm(`确定要拒绝 ${userIds.length} 个用户的审核吗？`)) {
    return;
  }
  
  try {
    const response = await fetch(`${API_BASE}/api/super-admin/users/batch-approve`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        user_ids: userIds,
        action: 'reject'
      })
    });
    
    const data = await response.json();
    
    if (data.success) {
      alert(`成功拒绝 ${data.data.success_count} 个用户的审核`);
      loadUsers();
    } else {
      alert('批量审核失败: ' + data.message);
    }
  } catch (error) {
    console.error('批量审核失败:', error);
    alert('批量审核失败: ' + error.message);
  }
}

// 加载邀请码列表
async function loadInvitationCodes() {
  try {
    const response = await fetch(`${API_BASE}/api/super-admin/invitation-codes`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    
    const data = await response.json();
    
    if (!data.success) {
      throw new Error(data.message);
    }
    
    const tbody = document.getElementById('invitationCodesTableBody');
    
    if (data.data.length === 0) {
      tbody.innerHTML = '<tr><td colspan="11" class="loading">暂无邀请码</td></tr>';
      return;
    }
    
    tbody.innerHTML = data.data.map(code => {
      const statusHtml = code.can_use 
        ? '<span style="color: #10b981; font-weight: 600;">✓ 可用</span>'
        : code.is_expired
        ? '<span style="color: #f87171; font-weight: 600;">✗ 已过期</span>'
        : code.is_used_up
        ? '<span style="color: #f87171; font-weight: 600;">✗ 已用完</span>'
        : '<span style="color: #f87171; font-weight: 600;">✗ 已禁用</span>';
      
      const remainingUses = Math.max(0, code.max_uses - code.used_count);
      const expiresAt = code.expires_at 
        ? new Date(code.expires_at).toLocaleString('zh-CN')
        : '永不过期';
      
      return `
        <tr>
          <td>${code.id}</td>
          <td>
            <div style="display: flex; align-items: center; gap: 8px;">
              <code style="background: var(--card-bg); padding: 4px 8px; border-radius: 4px; font-family: monospace; font-size: 14px;">${code.code}</code>
              <button class="btn-copy-code" onclick="copyInvitationCode('${code.code}', this)" title="复制邀请码">
                <span class="copy-icon">📋</span>
                <span class="copy-text">复制</span>
              </button>
            </div>
          </td>
          <td>${code.max_uses}</td>
          <td>${code.used_count}</td>
          <td>${remainingUses}</td>
          <td>${expiresAt}</td>
          <td>${code.role === 'super_admin' ? '超级管理员' : '普通用户'}</td>
          <td>${statusHtml}</td>
          <td>${code.created_by_username || '-'}</td>
          <td>${new Date(code.created_at).toLocaleString('zh-CN')}</td>
          <td>
            <button class="btn-delete" onclick="deleteInvitationCode(${code.id}, '${code.code}')">删除</button>
          </td>
        </tr>
      `;
    }).join('');
    
  } catch (error) {
    console.error('加载邀请码列表失败:', error);
    document.getElementById('invitationCodesTableBody').innerHTML = 
      `<tr><td colspan="11" class="loading">加载失败: ${error.message}</td></tr>`;
  }
}

// 生成邀请码
async function handleGenerateInviteCode(e) {
  e.preventDefault();
  
  const maxUses = parseInt(document.getElementById('inviteCodeMaxUses').value);
  const expiresAt = document.getElementById('inviteCodeExpiresAt').value;
  const role = document.getElementById('inviteCodeRole').value;
  
  const statusEl = document.getElementById('generateInviteCodeStatus');
  statusEl.style.display = 'none';
  
  try {
    const response = await fetch(`${API_BASE}/api/super-admin/invitation-codes`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        max_uses: maxUses,
        expires_at: expiresAt || null,
        role: role
      })
    });
    
    const data = await response.json();
    
    if (data.success) {
      statusEl.className = 'status-message success';
      statusEl.textContent = `邀请码生成成功: ${data.data.code}`;
      statusEl.style.display = 'block';
      
      // 清空表单
      document.getElementById('generateInviteCodeForm').reset();
      
      // 刷新列表
      loadInvitationCodes();
      
      // 3秒后关闭
      setTimeout(() => {
        closeGenerateInviteCodeModal();
      }, 3000);
    } else {
      statusEl.className = 'status-message error';
      statusEl.textContent = '生成失败: ' + data.message;
      statusEl.style.display = 'block';
    }
  } catch (error) {
    console.error('生成邀请码失败:', error);
    statusEl.className = 'status-message error';
    statusEl.textContent = '生成失败: ' + error.message;
    statusEl.style.display = 'block';
  }
}

// 关闭生成邀请码模态框
function closeGenerateInviteCodeModal() {
  document.getElementById('generateInviteCodeModal').style.display = 'none';
  document.getElementById('generateInviteCodeStatus').style.display = 'none';
  document.getElementById('generateInviteCodeForm').reset();
}

// 复制邀请码
async function copyInvitationCode(code, buttonElement) {
  try {
    // 使用 Clipboard API 复制到剪贴板
    await navigator.clipboard.writeText(code);
    
    // 保存原始状态
    const originalText = buttonElement.querySelector('.copy-text').textContent;
    const originalIcon = buttonElement.querySelector('.copy-icon').textContent;
    
    // 更新按钮状态，显示复制成功
    buttonElement.querySelector('.copy-text').textContent = '已复制';
    buttonElement.querySelector('.copy-icon').textContent = '✓';
    buttonElement.style.background = '#10b981'; // 绿色表示成功
    
    // 2秒后恢复原状
    setTimeout(() => {
      buttonElement.querySelector('.copy-text').textContent = originalText;
      buttonElement.querySelector('.copy-icon').textContent = originalIcon;
      buttonElement.style.background = ''; // 移除内联样式，回退到CSS类
    }, 2000);
  } catch (error) {
    console.error('复制失败:', error);
    // 如果 Clipboard API 不可用，使用备用方法
    try {
      const textArea = document.createElement('textarea');
      textArea.value = code;
      textArea.style.position = 'fixed';
      textArea.style.opacity = '0';
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand('copy');
      document.body.removeChild(textArea);
      
      // 保存原始状态
      const originalText = buttonElement.querySelector('.copy-text').textContent;
      const originalIcon = buttonElement.querySelector('.copy-icon').textContent;
      
      // 更新按钮状态
      buttonElement.querySelector('.copy-text').textContent = '已复制';
      buttonElement.querySelector('.copy-icon').textContent = '✓';
      buttonElement.style.background = '#10b981';
      
      setTimeout(() => {
        buttonElement.querySelector('.copy-text').textContent = originalText;
        buttonElement.querySelector('.copy-icon').textContent = originalIcon;
        buttonElement.style.background = ''; // 移除内联样式，回退到CSS类
      }, 2000);
    } catch (fallbackError) {
      alert('复制失败，请手动复制: ' + code);
    }
  }
}

// 删除邀请码
async function deleteInvitationCode(codeId, code) {
  if (!confirm(`确定要删除邀请码 "${code}" 吗？`)) {
    return;
  }
  
  try {
    const response = await fetch(`${API_BASE}/api/super-admin/invitation-codes/${codeId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    
    const data = await response.json();
    
    if (data.success) {
      alert('邀请码已删除');
      loadInvitationCodes();
    } else {
      alert('删除失败: ' + data.message);
    }
  } catch (error) {
    console.error('删除邀请码失败:', error);
    alert('删除失败: ' + error.message);
  }
}

// ========== 商家分析功能 ==========

// 全局变量：保存商家分析的原始数据
let merchantAnalysisData = [];
let merchantAnalysisCurrentPage = 1;
let merchantAnalysisPageSize = 10; // 每页显示10个商家

// 计算快速日期范围
function calculateQuickDateRange(days, type) {
  const today = new Date();
  let startDate, endDate;
  
  if (type === 'thisMonth') {
    // 本月
    startDate = new Date(today.getFullYear(), today.getMonth(), 1);
    endDate = new Date(today.getFullYear(), today.getMonth() + 1, 0);
  } else if (type === 'lastMonth') {
    // 上月
    startDate = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    endDate = new Date(today.getFullYear(), today.getMonth(), 0);
  } else if (days == 0) {
    // 今天
    startDate = new Date(today);
    endDate = new Date(today);
  } else if (days == 1) {
    // 昨天
    startDate = new Date(today);
    startDate.setDate(today.getDate() - 1);
    endDate = new Date(startDate);
  } else {
    // 最近N天（不包含今天）
    endDate = new Date(today);
    endDate.setDate(endDate.getDate() - 1); // 昨天（排除今天）
    startDate = new Date(endDate);
    startDate.setDate(startDate.getDate() - (days - 1)); // 从昨天往前推days-1天
  }
  
  // 格式化为 YYYY-MM-DD
  const formatDate = (date) => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };
  
  return {
    startDate: formatDate(startDate),
    endDate: formatDate(endDate)
  };
}

// 加载商家分析数据
async function loadMerchantAnalysis(startDate = null, endDate = null) {
  try {
    const params = new URLSearchParams();
    if (startDate) params.append('startDate', startDate);
    if (endDate) params.append('endDate', endDate);
    
    const queryString = params.toString();
    const url = `${API_BASE}/api/super-admin/platform-merchant-analysis${queryString ? '?' + queryString : ''}`;
    
    document.getElementById('merchantAnalysisContent').innerHTML = '<div class="loading">加载中...</div>';
    
    const response = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    const data = await response.json();
    
    if (!data.success) {
      throw new Error(data.message);
    }

    const merchants = data.data;

    if (merchants.length === 0) {
      document.getElementById('merchantAnalysisContent').innerHTML = '<p>暂无数据</p>';
      merchantAnalysisData = [];
      return;
    }

    // 按照 ROI 降序排序
    merchants.sort((a, b) => {
      const roiA = parseFloat(a.totals.roi) || 0;
      const roiB = parseFloat(b.totals.roi) || 0;
      return roiB - roiA; // 降序排序，ROI 高的在前
    });

    // 保存排序后的数据
    merchantAnalysisData = merchants;
    
    // 渲染数据
    renderMerchantAnalysis(merchants);

  } catch (error) {
    console.error('加载商家分析失败:', error);
    document.getElementById('merchantAnalysisContent').innerHTML = 
      `<div style="color: var(--danger-color);">加载失败: ${error.message}</div>`;
    merchantAnalysisData = [];
  }
}

// 渲染商家分析数据
function renderMerchantAnalysis(merchants, page = 1) {
  merchantAnalysisCurrentPage = page;
  
  if (merchants.length === 0) {
    document.getElementById('merchantAnalysisContent').innerHTML = '<p>没有找到匹配的数据</p>';
    return;
  }

  // 计算分页
  const totalPages = Math.ceil(merchants.length / merchantAnalysisPageSize);
  const startIndex = (page - 1) * merchantAnalysisPageSize;
  const endIndex = startIndex + merchantAnalysisPageSize;
  const paginatedMerchants = merchants.slice(startIndex, endIndex);

  // 添加分页信息和页面大小选择器
  let html = `
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; padding: 16px; background: var(--card-bg); border-radius: 8px; border: 1px solid var(--border-color);">
      <div style="color: var(--text-secondary); font-size: 14px;">
        共 <strong style="color: var(--primary-color);">${merchants.length}</strong> 个商家，
        显示第 <strong style="color: var(--primary-color);">${startIndex + 1}</strong> - <strong style="color: var(--primary-color);">${Math.min(endIndex, merchants.length)}</strong> 条
      </div>
      <div style="display: flex; gap: 8px; align-items: center;">
        <label style="color: var(--text-secondary); font-size: 13px;">每页显示:</label>
        <select id="merchantPageSizeSelector" style="padding: 6px 12px; background: var(--dark-bg); border: 1px solid var(--border-color); border-radius: 4px; color: var(--text-primary); font-size: 13px;">
          <option value="5" ${merchantAnalysisPageSize === 5 ? 'selected' : ''}>5条</option>
          <option value="10" ${merchantAnalysisPageSize === 10 ? 'selected' : ''}>10条</option>
          <option value="20" ${merchantAnalysisPageSize === 20 ? 'selected' : ''}>20条</option>
          <option value="50" ${merchantAnalysisPageSize === 50 ? 'selected' : ''}>50条</option>
          <option value="100" ${merchantAnalysisPageSize === 100 ? 'selected' : ''}>100条</option>
        </select>
      </div>
    </div>
  `;
  
  html += '<div class="merchant-analysis-container">';
  
  paginatedMerchants.forEach((merchant, index) => {
    const globalIndex = startIndex + index;
      const totals = merchant.totals;
      const merchantROIColor = totals.roi >= 0 ? 'var(--secondary-color)' : 'var(--danger-color)';
      
      html += `
        <div class="merchant-card">
          <div class="merchant-header">
            <h3>
              <span style="color: var(--warning-color);">#${globalIndex + 1}</span>
              商家ID: <strong style="color: var(--primary-color);">${merchant.merchant_id}</strong>
            </h3>
            <div class="merchant-totals">
              <span>总预算: <strong style="color: var(--primary-color);">$${totals.total_budget.toFixed(2)}</strong></span>
              <span>总广告费: <strong style="color: var(--danger-color);">$${totals.total_cost.toFixed(2)}</strong></span>
              <span>总佣金: <strong style="color: var(--secondary-color);">$${totals.total_commission.toFixed(2)}</strong></span>
              <span>总ROI: <strong style="color: ${merchantROIColor};">${totals.roi}</strong></span>
            </div>
          </div>
          
          <table class="data-table merchant-users-table">
            <thead>
              <tr>
                <th>用户</th>
                <th>广告系列</th>
                <th>预算</th>
                <th>展示</th>
                <th>点击</th>
                <th>广告费</th>
                <th>订单</th>
                <th>佣金</th>
                <th>CR</th>
                <th>EPC</th>
                <th>CPC</th>
                <th>ROI</th>
              </tr>
            </thead>
            <tbody>
      `;
      
      merchant.users.forEach(user => {
        const roiColor = user.roi >= 0 ? 'var(--secondary-color)' : 'var(--danger-color)';
        html += `
          <tr>
            <td>
              <div style="font-weight: 600; color: var(--text-primary);">${user.username || user.email}</div>
              <div style="font-size: 11px; color: var(--text-secondary);">${user.affiliate_name || '-'}</div>
            </td>
            <td style="font-size: 12px; max-width: 200px;" title="${user.campaign_names || '-'}">
              ${(user.campaign_names || '-').substring(0, 40)}${(user.campaign_names || '').length > 40 ? '...' : ''}
            </td>
            <td style="color: var(--primary-color);">$${user.total_budget.toFixed(2)}</td>
            <td style="color: var(--primary-color);">${user.total_impressions.toLocaleString()}</td>
            <td style="color: var(--primary-color);">${user.total_clicks.toLocaleString()}</td>
            <td><strong style="color: var(--danger-color);">$${user.total_cost.toFixed(2)}</strong></td>
            <td>${user.order_count}</td>
            <td><strong style="color: var(--secondary-color);">$${user.total_commission.toFixed(2)}</strong></td>
            <td><strong style="color: var(--secondary-color);">${user.cr}%</strong></td>
            <td><strong style="color: var(--secondary-color);">$${user.epc}</strong></td>
            <td><strong style="color: var(--secondary-color);">$${user.cpc}</strong></td>
            <td><strong style="color: ${roiColor};">${user.roi}</strong></td>
          </tr>
        `;
      });
      
      html += `
            </tbody>
          </table>
        </div>
      `;
    });
    
    html += '</div>'; // 关闭 merchant-analysis-container
    
    // 添加分页控件
    if (totalPages > 1) {
      html += '<div class="pagination" style="margin-top: 24px; display: flex; justify-content: center; gap: 8px;">';
      
      // 上一页按钮
      html += `<button ${page === 1 ? 'disabled' : ''} onclick="changeMerchantAnalysisPage(${page - 1})" style="padding: 8px 16px; background: var(--card-bg); color: var(--text-primary); border: 1px solid var(--border-color); border-radius: 4px; cursor: pointer;">上一页</button>`;
      
      // 页码按钮
      const maxButtons = 7;
      let startPage = Math.max(1, page - Math.floor(maxButtons / 2));
      let endPage = Math.min(totalPages, startPage + maxButtons - 1);
      
      if (endPage - startPage < maxButtons - 1) {
        startPage = Math.max(1, endPage - maxButtons + 1);
      }
      
      // 第一页
      if (startPage > 1) {
        html += `<button onclick="changeMerchantAnalysisPage(1)" style="padding: 8px 12px; background: var(--card-bg); color: var(--text-primary); border: 1px solid var(--border-color); border-radius: 4px; cursor: pointer;">1</button>`;
        if (startPage > 2) {
          html += '<span style="padding: 8px; color: var(--text-secondary);">...</span>';
        }
      }
      
      // 中间页码
      for (let i = startPage; i <= endPage; i++) {
        const isActive = i === page;
        html += `<button onclick="changeMerchantAnalysisPage(${i})" style="padding: 8px 12px; background: ${isActive ? 'var(--primary-color)' : 'var(--card-bg)'}; color: ${isActive ? 'white' : 'var(--text-primary)'}; border: 1px solid ${isActive ? 'var(--primary-color)' : 'var(--border-color)'}; border-radius: 4px; cursor: pointer; font-weight: ${isActive ? '600' : 'normal'};">${i}</button>`;
      }
      
      // 最后一页
      if (endPage < totalPages) {
        if (endPage < totalPages - 1) {
          html += '<span style="padding: 8px; color: var(--text-secondary);">...</span>';
        }
        html += `<button onclick="changeMerchantAnalysisPage(${totalPages})" style="padding: 8px 12px; background: var(--card-bg); color: var(--text-primary); border: 1px solid var(--border-color); border-radius: 4px; cursor: pointer;">${totalPages}</button>`;
      }
      
      // 下一页按钮
      html += `<button ${page === totalPages ? 'disabled' : ''} onclick="changeMerchantAnalysisPage(${page + 1})" style="padding: 8px 16px; background: var(--card-bg); color: var(--text-primary); border: 1px solid var(--border-color); border-radius: 4px; cursor: pointer;">下一页</button>`;
      
      html += '</div>';
    }
    
    document.getElementById('merchantAnalysisContent').innerHTML = html;
    
    // 绑定页面大小选择器事件
    const pageSizeSelector = document.getElementById('merchantPageSizeSelector');
    if (pageSizeSelector) {
      pageSizeSelector.addEventListener('change', (e) => {
        merchantAnalysisPageSize = parseInt(e.target.value);
        renderMerchantAnalysis(merchants, 1); // 重置到第一页
      });
    }
    
    // 滚动到顶部
    document.getElementById('merchantAnalysisContent').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// 切换商家分析页面
function changeMerchantAnalysisPage(page) {
  const searchTerm = document.getElementById('merchantAnalysisSearch').value.toLowerCase().trim();
  
  if (searchTerm) {
    // 如果有搜索，使用过滤后的数据
    filterMerchantAnalysis(page);
  } else {
    // 没有搜索，使用全部数据
    renderMerchantAnalysis(merchantAnalysisData, page);
  }
}

// 过滤商家分析数据
function filterMerchantAnalysis(page = 1) {
  const searchTerm = document.getElementById('merchantAnalysisSearch').value.toLowerCase().trim();
  
  if (!searchTerm) {
    // 没有搜索词，显示所有数据
    renderMerchantAnalysis(merchantAnalysisData, page);
    return;
  }
  
  // 过滤数据
  const filteredMerchants = merchantAnalysisData.map(merchant => {
    // 检查商家ID是否匹配
    const merchantIdMatch = merchant.merchant_id.toString().toLowerCase().includes(searchTerm);
    
    // 过滤用户
    const filteredUsers = merchant.users.filter(user => {
      const usernameMatch = (user.username || '').toLowerCase().includes(searchTerm);
      const emailMatch = (user.email || '').toLowerCase().includes(searchTerm);
      const affiliateMatch = (user.affiliate_name || '').toLowerCase().includes(searchTerm);
      const campaignMatch = (user.campaign_names || '').toLowerCase().includes(searchTerm);
      
      return usernameMatch || emailMatch || affiliateMatch || campaignMatch;
    });
    
    // 如果商家ID匹配，返回所有用户；否则只返回匹配的用户
    if (merchantIdMatch) {
      return merchant;
    } else if (filteredUsers.length > 0) {
      // 重新计算商家总计
      const totals = filteredUsers.reduce((acc, user) => {
        acc.total_budget += user.total_budget;
        acc.total_impressions += user.total_impressions;
        acc.total_clicks += user.total_clicks;
        acc.total_cost += user.total_cost;
        acc.order_count += user.order_count;
        acc.total_commission += user.total_commission;
        return acc;
      }, {
        total_budget: 0,
        total_impressions: 0,
        total_clicks: 0,
        total_cost: 0,
        order_count: 0,
        total_commission: 0
      });
      
      const merchantROI = totals.total_cost > 0
        ? ((totals.total_commission - totals.total_cost) / totals.total_cost).toFixed(2)
        : '0.00';
      
      return {
        merchant_id: merchant.merchant_id,
        users: filteredUsers,
        totals: {
          ...totals,
          roi: parseFloat(merchantROI)
        }
      };
    } else {
      return null;
    }
  }).filter(merchant => merchant !== null);
  
  // 按照 ROI 降序排序过滤后的数据
  filteredMerchants.sort((a, b) => {
    const roiA = parseFloat(a.totals.roi) || 0;
    const roiB = parseFloat(b.totals.roi) || 0;
    return roiB - roiA; // 降序排序，ROI 高的在前
  });
  
  // 渲染过滤后的数据
  renderMerchantAnalysis(filteredMerchants, page);
}

// ============ 超管个人设置功能 ============

/**
 * 打开超管个人设置 Modal
 */
function openAdminProfileSettings() {
  if (!currentAdmin) {
    alert('请先登录');
    return;
  }

  // 填充当前管理员信息
  document.getElementById('adminProfileEmail').value = currentAdmin.email;
  document.getElementById('adminProfileUsername').value = currentAdmin.username;
  
  // 清空密码字段
  document.getElementById('adminProfileCurrentPassword').value = '';
  document.getElementById('adminProfileNewPassword').value = '';
  document.getElementById('adminProfileConfirmPassword').value = '';
  
  // 清空状态消息
  document.getElementById('adminProfileSettingsStatus').textContent = '';
  
  // 显示 Modal
  document.getElementById('adminProfileSettingsModal').style.display = 'flex';
}

/**
 * 关闭超管个人设置 Modal
 */
function closeAdminProfileSettings() {
  document.getElementById('adminProfileSettingsModal').style.display = 'none';
}

/**
 * 处理超管个人设置表单提交
 */
document.addEventListener('DOMContentLoaded', () => {
  const adminProfileForm = document.getElementById('adminProfileSettingsForm');
  if (adminProfileForm) {
    adminProfileForm.addEventListener('submit', handleAdminProfileSettingsSubmit);
  }
});

async function handleAdminProfileSettingsSubmit(e) {
  e.preventDefault();
  
  const statusDiv = document.getElementById('adminProfileSettingsStatus');
  statusDiv.textContent = '正在保存...';
  statusDiv.className = 'status-message';
  
  const username = document.getElementById('adminProfileUsername').value.trim();
  const currentPassword = document.getElementById('adminProfileCurrentPassword').value;
  const newPassword = document.getElementById('adminProfileNewPassword').value;
  const confirmPassword = document.getElementById('adminProfileConfirmPassword').value;
  
  // 验证用户名
  if (!username) {
    statusDiv.textContent = '❌ 用户名不能为空';
    statusDiv.className = 'status-message error';
    return;
  }
  
  // 如果填写了新密码，进行密码相关验证
  if (newPassword || confirmPassword) {
    // 检查是否填写了当前密码
    if (!currentPassword) {
      statusDiv.textContent = '❌ 修改密码需要提供当前密码';
      statusDiv.className = 'status-message error';
      return;
    }
    
    // 检查新密码长度
    if (newPassword.length < 6) {
      statusDiv.textContent = '❌ 新密码长度至少为6位';
      statusDiv.className = 'status-message error';
      return;
    }
    
    // 检查两次密码是否一致
    if (newPassword !== confirmPassword) {
      statusDiv.textContent = '❌ 两次密码输入不一致';
      statusDiv.className = 'status-message error';
      return;
    }
  }
  
  try {
    // 准备请求数据
    const requestData = {
      username: username
    };
    
    // 如果要修改密码，添加密码字段
    if (newPassword) {
      requestData.currentPassword = currentPassword;
      requestData.newPassword = newPassword;
    }
    
    const response = await fetch(`${API_BASE}/api/user/profile`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify(requestData)
    });
    
    const result = await response.json();
    
    if (result.success) {
      statusDiv.textContent = '✅ ' + result.message;
      statusDiv.className = 'status-message success';
      
      // 更新当前管理员信息
      currentAdmin.username = username;
      document.getElementById('adminName').textContent = username;
      
      // 2秒后关闭 Modal
      setTimeout(() => {
        closeAdminProfileSettings();
        
        // 如果修改了密码，提示用户重新登录
        if (newPassword) {
          alert('密码已修改，请重新登录');
          redirectToLogin();
        }
      }, 2000);
    } else {
      statusDiv.textContent = `❌ ${result.message}`;
      statusDiv.className = 'status-message error';
    }
  } catch (error) {
    statusDiv.textContent = `❌ 更新失败: ${error.message}`;
    statusDiv.className = 'status-message error';
  }
}

// 点击 Modal 外部关闭
window.addEventListener('click', function(event) {
  const modal = document.getElementById('adminProfileSettingsModal');
  if (event.target === modal) {
    closeAdminProfileSettings();
  }
});

// ==================== 数据采集功能 ====================

// 用户商家数据分页变量
let userStatsCurrentPage = 1;
let userStatsPageSize = 50;
let userStatsAllData = [];
let collectionDateSyncInitialized = false;

// 加载采集状态页面
async function loadCollectionPage() {
  console.log('📊 加载数据采集页面');
  
  // 设置默认日期范围为最近7天（不包含今天）
  setCollectionDateRange('last7days', { refreshCollectionStats: false });
  initCollectionDateSync();
  
  // 绑定分页事件
  document.getElementById('userStatsPageSize').addEventListener('change', (e) => {
    userStatsPageSize = parseInt(e.target.value);
    userStatsCurrentPage = 1;
    renderUserStatsTable(userStatsAllData);
  });
  
  await loadCollectionStatus();
}

// 设置采集日期范围
function setCollectionDateRange(range, options = {}) {
  const {
    syncMerchantDate = true,
    autoRefreshMerchant = true,
    refreshCollectionStats = true
  } = options;
  const today = new Date();
  let endDate = new Date(today);
  let startDate = new Date();
  
  switch(range) {
    case 'last7days':
      // 最近7天，不包含今天（结束日期是昨天）
      endDate.setDate(today.getDate() - 1); // 昨天
      startDate = new Date(endDate);
      startDate.setDate(startDate.getDate() - 6); // 从7天前开始（包含昨天共7天）
      break;
    case 'last30days':
      // 最近30天，不包含今天（结束日期是昨天）
      endDate.setDate(today.getDate() - 1); // 昨天
      startDate = new Date(endDate);
      startDate.setDate(startDate.getDate() - 29); // 从30天前开始（包含昨天共30天）
      break;
    case 'thisMonth':
      startDate = new Date(today.getFullYear(), today.getMonth(), 1);
      endDate.setDate(today.getDate() - 1); // 昨天（不包含今天）
      break;
    case 'lastMonth':
      startDate = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      endDate = new Date(today.getFullYear(), today.getMonth(), 0); // 上个月最后一天
      break;
    case 'thisYear':
      startDate = new Date(today.getFullYear(), 0, 1);
      endDate.setDate(today.getDate() - 1); // 昨天（不包含今天）
      break;
    case 'all':
      startDate = new Date('2024-01-01');
      endDate.setDate(today.getDate() - 1); // 昨天（不包含今天）
      break;
    default:
      // 默认最近7天，不包含今天
      endDate.setDate(today.getDate() - 1); // 昨天
      startDate = new Date(endDate);
      startDate.setDate(startDate.getDate() - 6); // 从7天前开始
  }
  
  const startValue = startDate.toISOString().split('T')[0];
  const endValue = endDate.toISOString().split('T')[0];
  document.getElementById('collectionStartDate').value = startValue;
  document.getElementById('collectionEndDate').value = endValue;
  
  if (syncMerchantDate) {
    syncMerchantAnalysisDateRange(startValue, endValue, autoRefreshMerchant);
  }
  
  if (refreshCollectionStats) {
    loadCollectionStatus(startValue, endValue);
  }
  
  // 更新按钮激活状态
  document.querySelectorAll('.quick-date-buttons .btn-quick-date').forEach(btn => {
    btn.classList.remove('active');
  });
  // 找到对应的按钮并激活
  const buttons = document.querySelectorAll('.quick-date-buttons .btn-quick-date');
  buttons.forEach(btn => {
    const onclick = btn.getAttribute('onclick');
    if (onclick && onclick.includes(`'${range}'`)) {
      btn.classList.add('active');
    }
  });
}

// 同步商家分析日期范围
function syncMerchantAnalysisDateRange(startDate, endDate, autoLoad = false) {
  const startInput = document.getElementById('merchantAnalysisStartDate');
  const endInput = document.getElementById('merchantAnalysisEndDate');
  
  if (!startInput || !endInput) {
    return;
  }
  
  if (startDate) {
    startInput.value = startDate;
  }
  if (endDate) {
    endInput.value = endDate;
  }
  
  if (autoLoad && startDate && endDate) {
    loadMerchantAnalysis(startDate, endDate);
  }
}

// 初始化采集日期与商家分析的联动
function initCollectionDateSync() {
  if (collectionDateSyncInitialized) {
    return;
  }
  
  const startInput = document.getElementById('collectionStartDate');
  const endInput = document.getElementById('collectionEndDate');
  if (!startInput || !endInput) {
    return;
  }
  
  const handleChange = () => {
    const startDate = startInput.value;
    const endDate = endInput.value;
    if (startDate && endDate) {
      syncMerchantAnalysisDateRange(startDate, endDate, true);
      loadCollectionStatus(startDate, endDate);
    }
  };
  
  startInput.addEventListener('change', handleChange);
  endInput.addEventListener('change', handleChange);
  collectionDateSyncInitialized = true;
}

// 加载用户采集状态
async function loadCollectionStatus(startDate = null, endDate = null) {
  try {
    const params = new URLSearchParams();
    params.append('t', new Date().getTime());
    
    const startValue = startDate || document.getElementById('collectionStartDate')?.value;
    const endValue = endDate || document.getElementById('collectionEndDate')?.value;
    if (startValue) params.append('startDate', startValue);
    if (endValue) params.append('endDate', endValue);
    
    const response = await fetch(`${API_BASE}/api/super-admin/collection-status?${params.toString()}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      }
    });
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const result = await response.json();
    
    if (result.success && result.data) {
      const statusList = result.data || [];
      
      // 更新统计卡片
      const totalUsers = statusList.length;
      const freshUsers = statusList.filter(u => 
        u.googleSheets && u.platformOrders &&
        u.googleSheets.status === 'fresh' && u.platformOrders.status === 'fresh'
      ).length;
      const outdatedUsers = totalUsers - freshUsers;
      
      document.getElementById('collectionTotalUsers').textContent = totalUsers || 0;
      document.getElementById('collectionFreshUsers').textContent = freshUsers || 0;
      document.getElementById('collectionOutdatedUsers').textContent = outdatedUsers || 0;
      
      // 渲染用户列表
      renderCollectionStatusTable(statusList);
    } else {
      console.error('加载采集状态失败:', result.message || '未知错误');
      // 即使失败也显示 0，而不是 "-"
      document.getElementById('collectionTotalUsers').textContent = 0;
      document.getElementById('collectionFreshUsers').textContent = 0;
      document.getElementById('collectionOutdatedUsers').textContent = 0;
      // 显示错误信息
      const tbody = document.getElementById('collectionStatusTableBody');
      if (tbody) {
        tbody.innerHTML = `<tr><td colspan="5" class="no-data">加载失败: ${result.message || '未知错误'}</td></tr>`;
      }
    }
  } catch (error) {
    console.error('加载采集状态错误:', error);
    // 即使出错也显示 0
    document.getElementById('collectionTotalUsers').textContent = 0;
    document.getElementById('collectionFreshUsers').textContent = 0;
    document.getElementById('collectionOutdatedUsers').textContent = 0;
    // 显示错误信息
    const tbody = document.getElementById('collectionStatusTableBody');
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="5" class="no-data">加载失败: ${error.message}</td></tr>`;
    }
    const userStatsTbody = document.getElementById('userStatsTableBody');
    if (userStatsTbody) {
      userStatsTbody.innerHTML = `<tr><td colspan="8" class="no-data">加载失败: ${error.message}</td></tr>`;
    }
  }
}

// 渲染用户采集状态表格
function renderCollectionStatusTable(statusList) {
  const tbody = document.getElementById('collectionStatusTableBody');
  
  if (statusList.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="no-data">暂无用户数据</td></tr>';
    return;
  }
  
  // 格式化时间显示
  const formatTimeAgo = (hoursAgo) => {
    if (!hoursAgo || hoursAgo === null || hoursAgo === undefined) return '从未采集';
    
    // 小于1小时，显示分钟
    if (hoursAgo < 1) {
      const minutes = Math.floor(hoursAgo * 60);
      if (minutes < 1) return '刚刚';
      if (minutes === 1) return '1分钟前';
      return `${minutes}分钟前`;
    }
    
    // 1小时到24小时之间，显示小时和分钟
    if (hoursAgo < 24) {
      const hours = Math.floor(hoursAgo);
      const minutes = Math.floor((hoursAgo - hours) * 60);
      
      if (hours === 0) {
        if (minutes === 0) return '刚刚';
        if (minutes === 1) return '1分钟前';
        return `${minutes}分钟前`;
      }
      
      if (minutes === 0) {
        if (hours === 1) return '1小时前';
        return `${hours}小时前`;
      }
      
      // 如果分钟数小于5，只显示小时
      if (minutes < 5) {
        return hours === 1 ? '1小时前' : `${hours}小时前`;
      }
      
      // 显示小时和分钟
      return `${hours}小时${minutes}分钟前`;
    }
    
    // 大于等于24小时，显示天数
    const days = Math.floor(hoursAgo / 24);
    if (days === 1) return '1天前';
    if (days < 7) return `${days}天前`;
    
    // 大于等于7天，显示周数
    const weeks = Math.floor(days / 7);
    if (weeks === 1) return '1周前';
    if (weeks < 4) return `${weeks}周前`;
    
    // 大于等于4周，显示月数
    const months = Math.floor(days / 30);
    if (months === 1) return '1个月前';
    if (months < 12) return `${months}个月前`;
    
    // 大于等于12个月，显示年数
    const years = Math.floor(days / 365);
    if (years === 1) return '1年前';
    return `${years}年前`;
  };
  
  tbody.innerHTML = statusList.map(user => {
    const sheetsStatusClass = user.googleSheets.status;
    const ordersStatusClass = user.platformOrders.status;
    
    const sheetsText = user.googleSheets.lastUpdate 
      ? formatTimeAgo(user.googleSheets.hoursAgo)
      : '从未采集';
    
    const ordersText = user.platformOrders.lastUpdate 
      ? formatTimeAgo(user.platformOrders.hoursAgo)
      : '从未采集';
    
    return `
      <tr>
        <td><strong>${user.username}</strong><br><small style="color: #94a3b8;">${user.email}</small></td>
        <td><span class="status-badge ${sheetsStatusClass}">${sheetsText}</span></td>
        <td><span class="status-badge ${ordersStatusClass}">${ordersText}</span></td>
        <td>${user.platformCount} 个平台</td>
        <td>
          <button class="btn-action" onclick="collectSingleUser(${user.userId}, 'all')" title="采集此用户">
            🔄 采集
          </button>
        </td>
      </tr>
    `;
  }).join('');
  
  // 渲染用户数据统计表格
  renderUserStatsTable(statusList);
}

// 渲染用户数据统计表格（按商家分组，支持分页）
function renderUserStatsTable(statusList) {
  const tbody = document.getElementById('userStatsTableBody');
  
  // 保存所有数据
  userStatsAllData = statusList;
  
  if (statusList.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" class="no-data">暂无数据</td></tr>';
    document.getElementById('userStatsPagingInfo').textContent = '显示 0 条数据';
    document.getElementById('userStatsPagination').innerHTML = '';
    return;
  }
  
  // 将所有商家数据展开为单行数组，并按ROI排序
  let allRows = [];
  statusList.forEach(user => {
    const merchants = user.merchants || [];
    
    if (merchants.length === 0) {
      // 如果用户没有商家数据，也显示一行提示
      allRows.push({
        type: 'no-data',
        user: user
      });
    } else {
      merchants.forEach((merchant) => {
        allRows.push({
          type: 'merchant',
          user: user,
          merchant: merchant
        });
      });
    }
  });
  
  // 如果有商家数据，按ROI降序排序（所有用户的商家混在一起）
  if (allRows.some(row => row.type === 'merchant')) {
    allRows.sort((a, b) => {
      if (a.type === 'no-data' && b.type === 'no-data') return 0;
      if (a.type === 'no-data') return 1; // no-data 排在后面
      if (b.type === 'no-data') return -1;
      const roiA = a.merchant.roi === -999999 ? -Infinity : a.merchant.roi;
      const roiB = b.merchant.roi === -999999 ? -Infinity : b.merchant.roi;
      return roiB - roiA; // 降序：ROI高的在前
    });
  }
  
  const totalRows = allRows.length;
  const totalPages = Math.ceil(totalRows / userStatsPageSize);
  const startIndex = (userStatsCurrentPage - 1) * userStatsPageSize;
  const endIndex = Math.min(startIndex + userStatsPageSize, totalRows);
  const pageData = allRows.slice(startIndex, endIndex);
  
  // 渲染当前页数据
  let html = '';
  pageData.forEach(row => {
    if (row.type === 'no-data') {
      html += `
        <tr>
          <td><strong>${row.user.username}</strong><br><small style="color: #94a3b8;">${row.user.email}</small></td>
          <td colspan="7" style="color: #94a3b8; text-align: center;">暂无商家数据</td>
        </tr>
      `;
    } else {
      const merchant = row.merchant;
      const budget = merchant.budget ? `$${merchant.budget.toFixed(2)}` : '-';
      const cost = merchant.cost ? `$${merchant.cost.toFixed(2)}` : '-';
      const commission = merchant.commission ? `$${merchant.commission.toFixed(2)}` : '$0.00';
      
      // 处理无效的ROI（广告费为0）
      let roi, roiClass, roiIcon;
      if (merchant.roi === -999999 || merchant.cost === 0) {
        roi = 'N/A';
        roiClass = 'roi-badge neutral';
        roiIcon = '⚠️';
      } else {
        roi = merchant.roi.toFixed(2);
        // ROI 样式和图标
        roiClass = 'roi-badge neutral';
        roiIcon = '➖';
        if (merchant.roi > 10) {
          roiClass = 'roi-badge super-high';
          roiIcon = '🔥';
        } else if (merchant.roi > 0) {
          roiClass = 'roi-badge positive';
          roiIcon = '📈';
        } else if (merchant.roi < 0) {
          roiClass = 'roi-badge negative';
          roiIcon = '📉';
        }
      }
      
      // 截断广告系列名称
      const campaignNames = merchant.campaignNames || '';
      const displayCampaigns = campaignNames.length > 50 
        ? campaignNames.substring(0, 50) + '...' 
        : campaignNames;
      
      // 每一行都显示用户名，不合并单元格
      html += `
        <tr>
          <td><strong>${row.user.username}</strong><br><small style="color: #94a3b8;">${row.user.email}</small></td>
          <td>${merchant.merchantId}</td>
          <td title="${campaignNames}">${displayCampaigns}</td>
          <td>${budget}</td>
          <td>${cost}</td>
          <td>${merchant.orderCount}</td>
          <td>${commission}</td>
          <td><span class="${roiClass}"><span class="roi-icon">${roiIcon}</span>${roi}</span></td>
        </tr>
      `;
    }
  });
  
  tbody.innerHTML = html;
  
  // 更新分页信息
  document.getElementById('userStatsPagingInfo').textContent = 
    `显示第 ${startIndex + 1}-${endIndex} 条，共 ${totalRows} 条数据`;
  
  // 渲染分页按钮
  renderUserStatsPagination(totalPages);
}

// 渲染用户统计分页按钮
function renderUserStatsPagination(totalPages) {
  const container = document.getElementById('userStatsPagination');
  
  if (totalPages <= 1) {
    container.innerHTML = '';
    return;
  }
  
  let html = '';
  
  // 上一页按钮
  html += `
    <button 
      style="padding: 6px 12px; background: ${userStatsCurrentPage === 1 ? 'var(--card-bg)' : 'var(--primary-color)'}; color: var(--text-primary); border: 1px solid var(--border-color); border-radius: 4px; cursor: ${userStatsCurrentPage === 1 ? 'not-allowed' : 'pointer'};"
      onclick="changeUserStatsPage(${userStatsCurrentPage - 1})"
      ${userStatsCurrentPage === 1 ? 'disabled' : ''}
    >
      ← 上一页
    </button>
  `;
  
  // 页码按钮
  const maxButtons = 5;
  let startPage = Math.max(1, userStatsCurrentPage - Math.floor(maxButtons / 2));
  let endPage = Math.min(totalPages, startPage + maxButtons - 1);
  
  if (endPage - startPage < maxButtons - 1) {
    startPage = Math.max(1, endPage - maxButtons + 1);
  }
  
  if (startPage > 1) {
    html += `<button style="padding: 6px 12px; background: var(--card-bg); color: var(--text-primary); border: 1px solid var(--border-color); border-radius: 4px; cursor: pointer;" onclick="changeUserStatsPage(1)">1</button>`;
    if (startPage > 2) {
      html += `<span style="color: var(--text-secondary); padding: 0 8px;">...</span>`;
    }
  }
  
  for (let i = startPage; i <= endPage; i++) {
    html += `
      <button 
        style="padding: 6px 12px; background: ${i === userStatsCurrentPage ? 'var(--primary-color)' : 'var(--card-bg)'}; color: var(--text-primary); border: 1px solid var(--border-color); border-radius: 4px; cursor: pointer; font-weight: ${i === userStatsCurrentPage ? 'bold' : 'normal'};"
        onclick="changeUserStatsPage(${i})"
      >
        ${i}
      </button>
    `;
  }
  
  if (endPage < totalPages) {
    if (endPage < totalPages - 1) {
      html += `<span style="color: var(--text-secondary); padding: 0 8px;">...</span>`;
    }
    html += `<button style="padding: 6px 12px; background: var(--card-bg); color: var(--text-primary); border: 1px solid var(--border-color); border-radius: 4px; cursor: pointer;" onclick="changeUserStatsPage(${totalPages})">${totalPages}</button>`;
  }
  
  // 下一页按钮
  html += `
    <button 
      style="padding: 6px 12px; background: ${userStatsCurrentPage === totalPages ? 'var(--card-bg)' : 'var(--primary-color)'}; color: var(--text-primary); border: 1px solid var(--border-color); border-radius: 4px; cursor: ${userStatsCurrentPage === totalPages ? 'not-allowed' : 'pointer'};"
      onclick="changeUserStatsPage(${userStatsCurrentPage + 1})"
      ${userStatsCurrentPage === totalPages ? 'disabled' : ''}
    >
      下一页 →
    </button>
  `;
  
  container.innerHTML = html;
}

// 切换用户统计页码
function changeUserStatsPage(page) {
  const totalPages = Math.ceil(userStatsAllData.flatMap(u => u.merchants || []).length / userStatsPageSize);
  if (page < 1 || page > totalPages) return;
  
  userStatsCurrentPage = page;
  renderUserStatsTable(userStatsAllData);
}

// 开始批量采集
async function startBatchCollection(type) {
  const typeText = {
    'all': '所有数据',
    'sheets': '表格数据',
    'platforms': '订单数据'
  };
  
  const confirmed = confirm(`确定要批量采集${typeText[type]}吗？\n这可能需要几分钟时间。`);
  if (!confirmed) return;
  
  // 显示进度Modal
  showCollectionProgress(typeText[type]);
  
  try {
    if (type === 'all' || type === 'sheets') {
      await collectSheets();
    }
    
    if (type === 'all' || type === 'platforms') {
      await collectPlatforms();
    }
    
    // 采集完成后更新状态
    await loadCollectionStatus();
    
    // 添加完成总结
    appendProgressDetails(`\n${'='.repeat(50)}\n`);
    appendProgressDetails(`🎉 所有数据采集完成！\n`);
    appendProgressDetails(`${'='.repeat(50)}\n`);
    appendProgressDetails(`✅ 数据已更新，请查看用户状态列表\n`);
    
    updateProgressTitle('✅ 采集完成！');
  } catch (error) {
    console.error('批量采集错误:', error);
    updateProgressDetails('❌ 采集过程出错: ' + error.message);
    updateProgressTitle('❌ 采集失败');
  }
}

// 采集单个用户
async function collectSingleUser(userId, type) {
  const confirmed = confirm('确定要采集此用户的数据吗？');
  if (!confirmed) return;
  
  showCollectionProgress('用户数据');
  
  try {
    if (type === 'all' || type === 'sheets') {
      await collectSheets([userId]);
    }
    
    if (type === 'all' || type === 'platforms') {
      await collectPlatforms([userId]);
    }
    
    await loadCollectionStatus();
    
    // 添加完成总结
    appendProgressDetails(`\n${'='.repeat(50)}\n`);
    appendProgressDetails(`🎉 用户数据采集完成！\n`);
    appendProgressDetails(`${'='.repeat(50)}\n`);
    appendProgressDetails(`✅ 数据已更新\n`);
    
    updateProgressTitle('✅ 采集完成！');
  } catch (error) {
    console.error('采集用户错误:', error);
    updateProgressDetails('❌ 采集过程出错: ' + error.message);
    updateProgressTitle('❌ 采集失败');
  }
}

// 采集Google表格数据
async function collectSheets(userIds = []) {
  updateProgressDetails('🔄 开始采集 Google Sheets 数据...\n⏳ 请稍候，正在处理中...\n');
  
  try {
    const response = await fetch(`${API_BASE}/api/super-admin/batch-collect-sheets`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ userIds })
    });
    
    // 检查响应状态
    if (!response.ok) {
      const text = await response.text();
      console.error('API 响应错误:', response.status, text);
      throw new Error(`HTTP ${response.status}: ${text.substring(0, 100)}`);
    }
    
    const result = await response.json();
    
    if (result.success && result.data) {
      const { total, success, failed, details } = result.data;
      
      updateProgressStats(success, failed, total);
      
      let detailsText = `\n${'='.repeat(50)}\n`;
      detailsText += `📊 Google Sheets 采集完成\n`;
      detailsText += `${'='.repeat(50)}\n`;
      detailsText += `✅ 成功: ${success} 个用户\n`;
      detailsText += `❌ 失败: ${failed} 个用户\n`;
      detailsText += `📦 总计: ${total} 个用户\n`;
      detailsText += `${'='.repeat(50)}\n\n`;
      
      if (success > 0) {
        detailsText += `✅ 成功列表:\n`;
        details.filter(u => u.success).forEach((user, index) => {
          detailsText += `  ${index + 1}. ${user.username}: ${user.rowsImported} 条数据\n`;
        });
      }
      
      if (failed > 0) {
        detailsText += `\n❌ 失败列表:\n`;
        details.filter(u => !u.success).forEach((user, index) => {
          detailsText += `  ${index + 1}. ${user.username}: ${user.error}\n`;
        });
      }
      
      appendProgressDetails(detailsText);
    } else {
      throw new Error(result.message || 'Google Sheets 采集失败');
    }
  } catch (error) {
    appendProgressDetails(`\n❌ Google Sheets 采集出错: ${error.message}\n`);
    throw error;
  }
}

// 采集平台订单数据
async function collectPlatforms(userIds = [], platforms = []) {
  // 获取日期范围
  const startDate = document.getElementById('collectionStartDate').value;
  const endDate = document.getElementById('collectionEndDate').value;
  
  appendProgressDetails('\n🔄 开始采集平台订单数据...\n⏳ 请稍候，正在处理中...\n');
  appendProgressDetails(`📅 日期范围: ${startDate} 至 ${endDate}\n`);
  
  try {
    const response = await fetch(`${API_BASE}/api/super-admin/batch-collect-platforms`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ userIds, platforms, startDate, endDate })
    });
    
    // 检查响应状态
    if (!response.ok) {
      const text = await response.text();
      console.error('API 响应错误:', response.status, text);
      throw new Error(`HTTP ${response.status}: ${text.substring(0, 100)}`);
    }
    
    const result = await response.json();
    
    if (result.success && result.data) {
      const { totalPlatforms, successPlatforms, failedPlatforms, details } = result.data;
      
      updateProgressStats(successPlatforms, failedPlatforms, totalPlatforms);
      
      let detailsText = `\n${'='.repeat(50)}\n`;
      detailsText += `💰 平台订单采集完成\n`;
      detailsText += `${'='.repeat(50)}\n`;
      detailsText += `✅ 成功: ${successPlatforms} 个平台\n`;
      detailsText += `❌ 失败: ${failedPlatforms} 个平台\n`;
      detailsText += `📦 总计: ${totalPlatforms} 个平台\n`;
      detailsText += `${'='.repeat(50)}\n\n`;
      
      details.forEach((user, index) => {
        detailsText += `👤 ${user.username}:\n`;
        
        const successPlatforms = [];
        const failedPlatforms = [];
        
        Object.keys(user.platforms).forEach(platform => {
          const platformResult = user.platforms[platform];
          // 跳过未配置账号的平台（不显示）
          if (platformResult.skipped) {
            return;
          }
          
          if (platformResult.success) {
            successPlatforms.push({ platform, orders: platformResult.orders });
          } else {
            failedPlatforms.push({ platform, error: platformResult.error });
          }
        });
        
        if (successPlatforms.length > 0) {
          successPlatforms.forEach(p => {
            // 如果是 0 条，说明数据已存在，显示友好提示
            if (p.orders === 0) {
              detailsText += `  ✅ ${p.platform}: 0 条新订单（数据已是最新）\n`;
            } else {
              detailsText += `  ✅ ${p.platform}: ${p.orders} 条新订单\n`;
            }
          });
        }
        
        if (failedPlatforms.length > 0) {
          failedPlatforms.forEach(p => {
            detailsText += `  ❌ ${p.platform}: ${p.error}\n`;
          });
        }
        
        detailsText += `\n`;
      });
      
      appendProgressDetails(detailsText);
    } else {
      throw new Error(result.message || '平台订单采集失败');
    }
  } catch (error) {
    appendProgressDetails(`\n❌ 平台订单采集出错: ${error.message}\n`);
    throw error;
  }
}

// 显示采集进度Modal
function showCollectionProgress(type) {
  const modal = document.getElementById('collectionProgressModal');
  const title = document.getElementById('collectionProgressTitle');
  
  title.textContent = `🔄 正在采集${type}...`;
  
  // 重置进度
  document.getElementById('collectionProgressText').textContent = '0 / 0';
  document.getElementById('collectionSuccessCount').textContent = '0';
  document.getElementById('collectionFailedCount').textContent = '0';
  document.getElementById('collectionProgressBar').style.width = '0%';
  document.getElementById('collectionProgressPercentage').textContent = '0%';
  document.getElementById('collectionProgressDetails').textContent = '准备中...';
  
  modal.style.display = 'flex';
}

// 关闭采集进度Modal
function closeCollectionProgress() {
  const modal = document.getElementById('collectionProgressModal');
  modal.style.display = 'none';
  
  // 延迟500ms后刷新数据，确保数据库写入完成
  setTimeout(() => {
    // 关闭后刷新数据采集页面的状态
    console.log('🔄 刷新采集状态数据...');
    loadCollectionStatus();
    
    // 如果当前在需要展示商家分析的页面，同步刷新
    if (currentPage === 'platform-stats' || currentPage === 'data-collection') {
      const startDate = document.getElementById('merchantAnalysisStartDate')?.value;
      const endDate = document.getElementById('merchantAnalysisEndDate')?.value;
      if (startDate && endDate) {
        console.log('🔄 刷新平台商家分析数据...');
        loadMerchantAnalysis(startDate, endDate);
      }
    }
  }, 500);
}

// 更新进度标题
function updateProgressTitle(title) {
  document.getElementById('collectionProgressTitle').textContent = title;
}

// 更新进度统计
function updateProgressStats(success, failed, total) {
  const current = success + failed;
  const percentage = total > 0 ? Math.round((current / total) * 100) : 0;
  
  document.getElementById('collectionProgressText').textContent = `${current} / ${total}`;
  document.getElementById('collectionSuccessCount').textContent = success;
  document.getElementById('collectionFailedCount').textContent = failed;
  document.getElementById('collectionProgressBar').style.width = `${percentage}%`;
  document.getElementById('collectionProgressPercentage').textContent = `${percentage}%`;
}

// 更新进度详情
function updateProgressDetails(text) {
  document.getElementById('collectionProgressDetails').textContent = text;
}

// 追加进度详情
function appendProgressDetails(text) {
  const detailsDiv = document.getElementById('collectionProgressDetails');
  detailsDiv.textContent += text;
  detailsDiv.scrollTop = detailsDiv.scrollHeight;
}

// ========== 导出功能 ==========

/**
 * 导出用户商家汇总
 */
async function exportUserSummary() {
  try {
    const exportBtn = document.getElementById('exportUserSummaryBtn');
    const originalHTML = exportBtn.innerHTML;

    // 禁用按钮并显示加载状态
    exportBtn.disabled = true;
    exportBtn.innerHTML = '<span>⏳</span> 生成中...';

    // 获取当前用户ID和筛选条件
    const userId = currentUserId;
    if (!userId) {
      throw new Error('未选择用户，请先进入用户详情页面');
    }
    const startDate = document.getElementById('userSummaryStartDate').value;
    const endDate = document.getElementById('userSummaryEndDate').value;

    console.log(`📊 超管导出用户商家汇总：用户=${userId}, 日期=${startDate}至${endDate}`);

    // 调用后端API
    const response = await fetch(`${API_BASE}/api/super-admin/export/user-summary/${userId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        startDate,
        endDate
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    // 检查是否是JSON错误响应
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const result = await response.json();
      if (!result.success) {
        throw new Error(result.message || '导出失败');
      }
    }

    // 获取文件blob
    const blob = await response.blob();

    // 从响应头获取文件名
    const contentDisposition = response.headers.get('Content-Disposition');
    let filename = '用户商家汇总.xlsx';
    if (contentDisposition) {
      const filenameMatch = contentDisposition.match(/filename\*?=['"]?(?:UTF-\d['"]*)?([^;\r\n"']*)['"]?;?/);
      if (filenameMatch && filenameMatch[1]) {
        filename = decodeURIComponent(filenameMatch[1]);
      }
    }

    // 创建下载链接
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();

    // 清理
    window.URL.revokeObjectURL(url);
    document.body.removeChild(a);

    // 显示成功消息
    showToast('✅ Excel文件已成功导出！', 'success');
    console.log('✅ 导出成功:', filename);

  } catch (error) {
    console.error('导出Excel失败:', error);
    showToast(`❌ 导出失败: ${error.message}`, 'error');
  } finally {
    // 恢复按钮状态
    const exportBtn = document.getElementById('exportUserSummaryBtn');
    exportBtn.disabled = false;
    exportBtn.innerHTML = '<span>📥</span> 导出Excel';
  }
}

/**
 * 导出平台统计数据
 */
async function exportPlatformStats() {
  try {
    const exportBtn = document.getElementById('exportPlatformStatsBtn');
    const originalHTML = exportBtn.innerHTML;

    // 禁用按钮并显示加载状态
    exportBtn.disabled = true;
    exportBtn.innerHTML = '<span>⏳</span> 生成中...';

    // 获取筛选条件
    const startDate = document.getElementById('statsStartDate').value;
    const endDate = document.getElementById('statsEndDate').value;

    console.log(`📊 超管导出平台统计：日期=${startDate}至${endDate}`);

    // 调用后端API
    const response = await fetch(`${API_BASE}/api/super-admin/export/platform-stats`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        startDate,
        endDate
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    // 检查是否是JSON错误响应
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const result = await response.json();
      if (!result.success) {
        throw new Error(result.message || '导出失败');
      }
    }

    // 获取文件blob
    const blob = await response.blob();

    // 从响应头获取文件名
    const contentDisposition = response.headers.get('Content-Disposition');
    let filename = '平台统计.xlsx';
    if (contentDisposition) {
      const filenameMatch = contentDisposition.match(/filename\*?=['"]?(?:UTF-\d['"]*)?([^;\r\n"']*)['"]?;?/);
      if (filenameMatch && filenameMatch[1]) {
        filename = decodeURIComponent(filenameMatch[1]);
      }
    }

    // 创建下载链接
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();

    // 清理
    window.URL.revokeObjectURL(url);
    document.body.removeChild(a);

    // 显示成功消息
    showToast('✅ Excel文件已成功导出！', 'success');
    console.log('✅ 导出成功:', filename);

  } catch (error) {
    console.error('导出Excel失败:', error);
    showToast(`❌ 导出失败: ${error.message}`, 'error');
  } finally {
    // 恢复按钮状态
    const exportBtn = document.getElementById('exportPlatformStatsBtn');
    exportBtn.disabled = false;
    exportBtn.innerHTML = '<span>📥</span> 导出Excel';
  }
}

/**
 * 导出平台商家分析数据
 */
async function exportMerchantAnalysis() {
  try {
    const exportBtn = document.getElementById('exportMerchantAnalysisBtn');
    const originalHTML = exportBtn.innerHTML;

    // 禁用按钮并显示加载状态
    exportBtn.disabled = true;
    exportBtn.innerHTML = '<span>⏳</span> 生成中...';

    // 获取筛选条件
    const startDate = document.getElementById('merchantAnalysisStartDate').value;
    const endDate = document.getElementById('merchantAnalysisEndDate').value;

    console.log(`📊 超管导出平台商家分析：日期=${startDate}至${endDate}`);

    // 调用后端API
    const response = await fetch(`${API_BASE}/api/super-admin/export/platform-merchant-analysis`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        startDate,
        endDate
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    // 检查是否是JSON错误响应
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const result = await response.json();
      if (!result.success) {
        throw new Error(result.message || '导出失败');
      }
    }

    // 获取文件blob
    const blob = await response.blob();

    // 从响应头获取文件名
    const contentDisposition = response.headers.get('Content-Disposition');
    let filename = '平台商家分析.xlsx';
    if (contentDisposition) {
      const filenameMatch = contentDisposition.match(/filename\*?=['"]?(?:UTF-\d['"]*)?([^;\r\n"']*)['"]?;?/);
      if (filenameMatch && filenameMatch[1]) {
        filename = decodeURIComponent(filenameMatch[1]);
      }
    }

    // 创建下载链接
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();

    // 清理
    window.URL.revokeObjectURL(url);
    document.body.removeChild(a);

    // 显示成功消息
    showToast('✅ Excel文件已成功导出！', 'success');
    console.log('✅ 导出成功:', filename);

  } catch (error) {
    console.error('导出Excel失败:', error);
    showToast(`❌ 导出失败: ${error.message}`, 'error');
  } finally {
    // 恢复按钮状态
    const exportBtn = document.getElementById('exportMerchantAnalysisBtn');
    exportBtn.disabled = false;
    exportBtn.innerHTML = '<span>📥</span> 导出Excel';
  }
}

// 简单的toast通知函数
function showToast(message, type = 'info') {
  // 创建toast元素
  const toast = document.createElement('div');
  toast.textContent = message;
  toast.style.cssText = `
    position: fixed;
    top: 80px;
    right: 20px;
    padding: 16px 24px;
    background: ${type === 'success' ? '#28a745' : type === 'error' ? '#dc3545' : '#3b82f6'};
    color: white;
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    z-index: 10000;
    font-size: 14px;
    font-weight: 500;
    animation: slideIn 0.3s ease;
  `;

  document.body.appendChild(toast);

  // 3秒后移除
  setTimeout(() => {
    toast.style.animation = 'slideOut 0.3s ease';
    setTimeout(() => {
      document.body.removeChild(toast);
    }, 300);
  }, 3000);
}

// 绑定导出按钮点击事件
document.addEventListener('DOMContentLoaded', () => {
  // 用户商家汇总导出
  const exportUserSummaryBtn = document.getElementById('exportUserSummaryBtn');
  if (exportUserSummaryBtn) {
    exportUserSummaryBtn.addEventListener('click', exportUserSummary);
  }

  // 平台统计导出
  const exportPlatformStatsBtn = document.getElementById('exportPlatformStatsBtn');
  if (exportPlatformStatsBtn) {
    exportPlatformStatsBtn.addEventListener('click', exportPlatformStats);
  }

  // 商家分析导出
  const exportMerchantAnalysisBtn = document.getElementById('exportMerchantAnalysisBtn');
  if (exportMerchantAnalysisBtn) {
    exportMerchantAnalysisBtn.addEventListener('click', exportMerchantAnalysis);
  }

  // 提现管理相关事件
  const withdrawalViewMode = document.getElementById('withdrawalViewMode');
  if (withdrawalViewMode) {
    withdrawalViewMode.addEventListener('change', handleWithdrawalViewModeChange);
  }

  const refreshWithdrawalBtn = document.getElementById('refreshWithdrawalBtn');
  if (refreshWithdrawalBtn) {
    refreshWithdrawalBtn.addEventListener('click', loadWithdrawalData);
  }

  const withdrawalPlatformFilter = document.getElementById('withdrawalPlatformFilter');
  if (withdrawalPlatformFilter) {
    withdrawalPlatformFilter.addEventListener('change', loadWithdrawalAccounts);
  }

  const withdrawalUserFilter = document.getElementById('withdrawalUserFilter');
  if (withdrawalUserFilter) {
    withdrawalUserFilter.addEventListener('change', loadWithdrawalAccounts);
  }

  // 日期筛选事件
  const withdrawalApplyDateFilter = document.getElementById('withdrawalApplyDateFilter');
  if (withdrawalApplyDateFilter) {
    withdrawalApplyDateFilter.addEventListener('click', () => {
      loadWithdrawalData();
    });
  }

  const withdrawalClearDateFilter = document.getElementById('withdrawalClearDateFilter');
  if (withdrawalClearDateFilter) {
    withdrawalClearDateFilter.addEventListener('click', () => {
      document.getElementById('withdrawalStartDate').value = '';
      document.getElementById('withdrawalEndDate').value = '';
      loadWithdrawalData();
    });
  }

  // 初始化日期为最近30天
  const initWithdrawalDates = () => {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 30);
    
    document.getElementById('withdrawalEndDate').value = endDate.toISOString().split('T')[0];
    document.getElementById('withdrawalStartDate').value = startDate.toISOString().split('T')[0];
  };
  
  // 页面加载时初始化日期
  if (document.getElementById('withdrawalStartDate')) {
    initWithdrawalDates();
  }
});

// ============ 提现管理功能 ============

// 设置提现日期范围
function setWithdrawalDateRange(days) {
  const endDate = new Date();
  const startDate = new Date();
  
  if (days === 0) {
    // 全部：清空日期
    document.getElementById('withdrawalStartDate').value = '';
    document.getElementById('withdrawalEndDate').value = '';
  } else {
    startDate.setDate(startDate.getDate() - days);
    document.getElementById('withdrawalStartDate').value = startDate.toISOString().split('T')[0];
    document.getElementById('withdrawalEndDate').value = endDate.toISOString().split('T')[0];
  }
  
  loadWithdrawalData();
}

// 加载提现数据
async function loadWithdrawalData() {
  const viewMode = document.getElementById('withdrawalViewMode')?.value || 'summary';
  
  if (viewMode === 'summary') {
    await loadWithdrawalSummary();
  } else {
    await loadWithdrawalAccounts();
  }
}

// 切换显示方式
function handleWithdrawalViewModeChange() {
  const viewMode = document.getElementById('withdrawalViewMode').value;
  const summaryView = document.getElementById('withdrawalSummaryView');
  const accountsView = document.getElementById('withdrawalAccountsView');

  if (viewMode === 'summary') {
    summaryView.style.display = 'block';
    accountsView.style.display = 'none';
    loadWithdrawalSummary();
  } else {
    summaryView.style.display = 'none';
    accountsView.style.display = 'block';
    loadWithdrawalAccounts();
  }
}

// 加载汇总数据
async function loadWithdrawalSummary() {
  try {
    showLoading('summaryHistoryTableBody', 9);

    // 获取日期筛选参数
    const startDate = document.getElementById('withdrawalStartDate')?.value || '';
    const endDate = document.getElementById('withdrawalEndDate')?.value || '';
    
    // 构建查询参数
    const params = new URLSearchParams();
    if (startDate) params.append('startDate', startDate);
    if (endDate) params.append('endDate', endDate);
    
    const queryString = params.toString() ? `?${params.toString()}` : '';
    
    console.log('📊 加载提现汇总数据，日期范围:', startDate || '不限', '至', endDate || '不限');

    const response = await fetch(`${API_BASE}/api/super-admin/withdrawal/summary${queryString}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    const result = await response.json();

    if (!result.success) {
      throw new Error(result.message || '获取数据失败');
    }

    const data = result.data;

    // 更新统计卡片
    document.getElementById('summaryAvailableToWithdraw').textContent = 
      formatCurrency(data.totalAvailable);
    document.getElementById('summaryPaymentInProgress').textContent = 
      formatCurrency(data.totalInProgress);
    document.getElementById('summaryTotalPaid').textContent = 
      formatCurrency(data.totalPaid);

    // 加载历史记录
    await loadWithdrawalHistory(1);

  } catch (error) {
    console.error('加载提现汇总数据失败:', error);
    showError('summaryHistoryTableBody', 9, error.message);
    showToast(`❌ 加载失败: ${error.message}`, 'error');
  }
}

// 加载提现历史记录
async function loadWithdrawalHistory(page = 1) {
  try {
    const platform = document.getElementById('withdrawalPlatformFilter')?.value || '';
    const userId = document.getElementById('withdrawalUserFilter')?.value || '';
    const startDate = document.getElementById('withdrawalStartDate')?.value || '';
    const endDate = document.getElementById('withdrawalEndDate')?.value || '';

    const params = new URLSearchParams({ page, pageSize: 20 });
    if (platform) params.append('platform', platform);
    if (userId) params.append('userId', userId);
    if (startDate) params.append('startDate', startDate);
    if (endDate) params.append('endDate', endDate);

    const response = await fetch(`${API_BASE}/api/super-admin/withdrawal/history?${params}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    const result = await response.json();

    if (!result.success) {
      throw new Error(result.message || '获取历史记录失败');
    }

    const data = result.data;
    const tbody = document.getElementById('summaryHistoryTableBody');

    if (data.list.length === 0) {
      tbody.innerHTML = '<tr><td colspan="9" class="empty">暂无数据</td></tr>';
      return;
    }

    tbody.innerHTML = data.list.map(item => `
      <tr>
        <td>${getPlatformName(item.platform || 'partnermatic')}</td>
        <td>${escapeHtml(item.accountName || '-')}${item.affiliateName ? ` (${escapeHtml(item.affiliateName)})` : ''}</td>
        <td>${escapeHtml(item.username || item.email || '-')}</td>
        <td>${formatDateTime(item.request_date || item.createdAt)}</td>
        <td>${item.paid_date ? formatDateTime(item.paid_date) : '-'}</td>
        <td>${item.payment_id || item.withdrawId || '-'}</td>
        <td><span class="status-badge status-${(item.status || '').toLowerCase()}">${getStatusText(item.status)}</span></td>
        <td>${item.payment_type || item.paymentMethod || '-'}</td>
        <td style="font-weight: 600;">${formatCurrency(item.amount || item.actualAmount || 0)}</td>
      </tr>
    `).join('');

    // 更新分页
    updatePagination('summaryHistoryPagination', data.page, data.totalPage, loadWithdrawalHistory);

  } catch (error) {
    console.error('加载提现历史记录失败:', error);
    showError('summaryHistoryTableBody', 9, error.message);
  }
}

// 加载按账号展示的数据
async function loadWithdrawalAccounts() {
  try {
    const accountsList = document.getElementById('withdrawalAccountsList');
    accountsList.innerHTML = '<div class="loading">加载中...</div>';

    const platform = document.getElementById('withdrawalPlatformFilter')?.value || '';
    const userId = document.getElementById('withdrawalUserFilter')?.value || '';
    const startDate = document.getElementById('withdrawalStartDate')?.value || '';
    const endDate = document.getElementById('withdrawalEndDate')?.value || '';

    // 构建查询参数
    const params = new URLSearchParams();
    if (startDate) params.append('startDate', startDate);
    if (endDate) params.append('endDate', endDate);
    
    const queryString = params.toString() ? `?${params.toString()}` : '';

    // 先获取汇总数据（包含所有账号信息）
    const response = await fetch(`${API_BASE}/api/super-admin/withdrawal/summary${queryString}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    const result = await response.json();

    if (!result.success) {
      throw new Error(result.message || '获取数据失败');
    }

    let accounts = result.data.accounts || [];

    // 筛选
    if (platform) {
      accounts = accounts.filter(acc => acc.platform === platform);
    }
    if (userId) {
      accounts = accounts.filter(acc => acc.userId === parseInt(userId));
    }

    if (accounts.length === 0) {
      accountsList.innerHTML = '<div class="empty">暂无数据</div>';
      return;
    }

    // 加载用户列表到筛选器
    await loadWithdrawalUserFilter();

    // 渲染账号卡片
    accountsList.innerHTML = accounts.map(account => `
      <div class="card" style="margin-bottom: 20px;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
          <div>
            <h3 style="margin: 0; color: var(--text-primary);">
              ${escapeHtml(account.accountName)}${account.affiliateName ? ` (${escapeHtml(account.affiliateName)})` : ''}
            </h3>
            <p style="margin: 5px 0 0 0; color: var(--text-secondary); font-size: 14px;">
              用户: ${escapeHtml(account.username || account.email)} | 平台: ${getPlatformName(account.platform)}
            </p>
          </div>
          <button class="btn-create" onclick="viewAccountWithdrawalDetail(${account.accountId})" style="background: var(--primary-color);">
            查看详情
          </button>
        </div>
        
        ${account.error ? `
          <div style="padding: 12px; background: #fee; border-left: 4px solid #f00; border-radius: 4px; color: #c00;">
            ⚠️ ${escapeHtml(account.error)}
          </div>
        ` : `
          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px;">
            <div style="padding: 15px; background: var(--bg-tertiary); border-radius: 8px;">
              <div style="color: var(--text-secondary); font-size: 13px; margin-bottom: 5px;">未提现金额</div>
              <div style="font-size: 24px; font-weight: 700; color: var(--primary-color);">
                ${formatCurrency(account.availableToWithdraw || 0)}
              </div>
            </div>
            <div style="padding: 15px; background: var(--bg-tertiary); border-radius: 8px;">
              <div style="color: var(--text-secondary); font-size: 13px; margin-bottom: 5px;">提现中金额</div>
              <div style="font-size: 24px; font-weight: 700; color: #f59e0b;">
                ${formatCurrency(account.paymentInProgress || 0)}
              </div>
            </div>
            <div style="padding: 15px; background: var(--bg-tertiary); border-radius: 8px;">
              <div style="color: var(--text-secondary); font-size: 13px; margin-bottom: 5px;">已提现金额</div>
              <div style="font-size: 24px; font-weight: 700; color: #10b981;">
                ${formatCurrency(account.totalPaid || 0)}
              </div>
            </div>
          </div>
          ${account.lastRequestedDate ? `
            <div style="margin-top: 10px; color: var(--text-secondary); font-size: 13px;">
              最后请求日期: ${formatDateTime(account.lastRequestedDate)}
            </div>
          ` : ''}
        `}
      </div>
    `).join('');

  } catch (error) {
    console.error('加载账号提现数据失败:', error);
    document.getElementById('withdrawalAccountsList').innerHTML = 
      `<div class="error">加载失败: ${escapeHtml(error.message)}</div>`;
    showToast(`❌ 加载失败: ${error.message}`, 'error');
  }
}

// 加载用户筛选器
async function loadWithdrawalUserFilter() {
  try {
    const response = await fetch(`${API_BASE}/api/super-admin/users?pageSize=1000`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    const result = await response.json();

    if (result.success && result.data) {
      const userFilter = document.getElementById('withdrawalUserFilter');
      if (userFilter) {
        const currentValue = userFilter.value;
        userFilter.innerHTML = '<option value="">全部用户</option>' +
          result.data.users.map(user => 
            `<option value="${user.id}">${escapeHtml(user.username || user.email)}</option>`
          ).join('');
        if (currentValue) {
          userFilter.value = currentValue;
        }
      }
    }
  } catch (error) {
    console.error('加载用户列表失败:', error);
  }
}

// 查看账号详情
async function viewAccountWithdrawalDetail(accountId) {
  try {
    // 获取日期筛选参数
    const startDate = document.getElementById('withdrawalStartDate')?.value || '';
    const endDate = document.getElementById('withdrawalEndDate')?.value || '';
    
    // 构建查询参数
    const params = new URLSearchParams();
    if (startDate) params.append('startDate', startDate);
    if (endDate) params.append('endDate', endDate);
    
    const queryString = params.toString() ? `?${params.toString()}` : '';
    
    const response = await fetch(`${API_BASE}/api/super-admin/withdrawal/account/${accountId}${queryString}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    const result = await response.json();

    if (!result.success) {
      throw new Error(result.message || '获取详情失败');
    }

    const data = result.data;
    const account = data.account;
    const summary = data.summary;
    const history = data.history;

    // 创建详情弹窗
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.style.display = 'block';
    modal.innerHTML = `
      <div class="modal-content" style="max-width: 900px; max-height: 90vh; overflow-y: auto;">
        <div class="modal-header">
          <h2>💰 账号提现详情 - ${escapeHtml(account.accountName)}</h2>
          <span class="modal-close" onclick="this.closest('.modal').remove()">&times;</span>
        </div>
        <div class="modal-body">
          ${data.error ? `
            <div style="padding: 12px; background: #fee; border-left: 4px solid #f00; border-radius: 4px; color: #c00; margin-bottom: 20px;">
              ⚠️ ${escapeHtml(data.error)}
            </div>
          ` : ''}
          
          ${summary ? `
            <div style="margin-bottom: 30px;">
              <h3 style="margin-bottom: 15px;">📊 统计信息</h3>
              <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 15px;">
                <div style="padding: 15px; background: var(--bg-tertiary); border-radius: 8px;">
                  <div style="color: var(--text-secondary); font-size: 13px; margin-bottom: 5px;">未提现金额</div>
                  <div style="font-size: 20px; font-weight: 700; color: var(--primary-color);">
                    ${formatCurrency(summary.availableToWithdraw || 0)}
                  </div>
                </div>
                <div style="padding: 15px; background: var(--bg-tertiary); border-radius: 8px;">
                  <div style="color: var(--text-secondary); font-size: 13px; margin-bottom: 5px;">提现中金额</div>
                  <div style="font-size: 20px; font-weight: 700; color: #f59e0b;">
                    ${formatCurrency(summary.paymentInProgress || 0)}
                  </div>
                </div>
                <div style="padding: 15px; background: var(--bg-tertiary); border-radius: 8px;">
                  <div style="color: var(--text-secondary); font-size: 13px; margin-bottom: 5px;">已提现金额</div>
                  <div style="font-size: 20px; font-weight: 700; color: #10b981;">
                    ${formatCurrency(summary.totalCommissionPaid || 0)}
                  </div>
                </div>
              </div>
            </div>
          ` : ''}

          ${history && history.list && history.list.length > 0 ? `
            <div>
              <h3 style="margin-bottom: 15px;">📋 提现历史（共 ${history.total || history.list.length} 条）</h3>
              <div class="table-wrapper">
                <table class="data-table">
                  <thead>
                    <tr>
                      <th>请求日期</th>
                      <th>支付日期</th>
                      <th>Payment ID</th>
                      <th>状态</th>
                      <th>支付方式</th>
                      <th>金额 ($)</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${history.list.map(item => `
                      <tr>
                        <td>${formatDateTime(item.request_date || item.createdAt)}</td>
                        <td>${item.paid_date ? formatDateTime(item.paid_date) : '-'}</td>
                        <td>${item.payment_id || item.withdrawId || '-'}</td>
                        <td><span class="status-badge status-${(item.status || '').toLowerCase()}">${getStatusText(item.status)}</span></td>
                        <td>${item.payment_type || item.paymentMethod || '-'}</td>
                        <td style="font-weight: 600;">${formatCurrency(item.amount || item.actualAmount || 0)}</td>
                      </tr>
                    `).join('')}
                  </tbody>
                </table>
              </div>
            </div>
          ` : '<p style="color: var(--text-secondary);">暂无历史记录</p>'}
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    // 点击遮罩关闭
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        modal.remove();
      }
    });

  } catch (error) {
    console.error('获取账号详情失败:', error);
    showToast(`❌ 获取详情失败: ${error.message}`, 'error');
  }
}

// 工具函数
function escapeHtml(text) {
  if (text == null) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatCurrency(amount) {
  if (typeof amount !== 'number') {
    amount = parseFloat(amount) || 0;
  }
  return '$' + amount.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function formatDateTime(dateStr) {
  if (!dateStr) return '-';
  try {
    const date = new Date(dateStr);
    return date.toLocaleString('zh-CN', { 
      year: 'numeric', 
      month: '2-digit', 
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  } catch (e) {
    return dateStr;
  }
}

function getPlatformName(platform) {
  const names = {
    'partnermatic': 'PartnerMatic',
    'linkhaitao': 'LinkHaitao',
    'linkbux': 'LinkBux',
    'rewardoo': 'Rewardoo'
  };
  return names[platform] || platform;
}

function getStatusText(status) {
  const statusMap = {
    'paid': '已支付',
    'pending': '待处理',
    'processing': '处理中',
    'rejected': '已拒绝',
    'cancelled': '已取消'
  };
  return statusMap[status?.toLowerCase()] || status || '-';
}

function showLoading(elementId, colSpan) {
  const element = document.getElementById(elementId);
  if (element) {
    element.innerHTML = `<tr><td colspan="${colSpan}" class="loading">加载中...</td></tr>`;
  }
}

function showError(elementId, colSpan, message) {
  const element = document.getElementById(elementId);
  if (element) {
    element.innerHTML = `<tr><td colspan="${colSpan}" class="error">${escapeHtml(message)}</td></tr>`;
  }
}

function updatePagination(elementId, currentPage, totalPage, callback) {
  const element = document.getElementById(elementId);
  if (!element) return;

  if (totalPage <= 1) {
    element.innerHTML = '';
    return;
  }

  let html = '';
  if (currentPage > 1) {
    html += `<button class="pagination-btn" onclick="${callback.name}(${currentPage - 1})">上一页</button>`;
  }
  html += `<span style="margin: 0 10px;">第 ${currentPage} / ${totalPage} 页</span>`;
  if (currentPage < totalPage) {
    html += `<button class="pagination-btn" onclick="${callback.name}(${currentPage + 1})">下一页</button>`;
  }

  element.innerHTML = html;
}

