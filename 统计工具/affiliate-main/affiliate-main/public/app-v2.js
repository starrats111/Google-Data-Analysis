// 多用户SaaS系统前端逻辑
const API_BASE = '/api';
let authToken = null;
let currentUser = null;
let platformAccounts = [];
let selectedAccountIds = []; // 改为数组，支持多选
let googleSheets = []; // Google表格列表
let expandedRows = new Map(); // 存储已展开的行数据 key: rowId, value: { loaded: boolean, data: [] }

// 页面加载完成后初始化
document.addEventListener('DOMContentLoaded', () => {
  // 检查是否有保存的token
  const savedToken = localStorage.getItem('authToken');
  if (savedToken) {
    authToken = savedToken;
    loadUserProfile();
  }

  // 设置默认日期（最近7天，不包含今天）
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1); // 昨天
  const weekAgo = new Date(today);
  weekAgo.setDate(today.getDate() - 7); // 7天前（从8天前到昨天，共7天）

  const startInput = document.getElementById('startDate');
  const endInput = document.getElementById('endDate');

  if (startInput && endInput) {
    // 设置开始日期为7天前（即8天前，因为不包含今天）
    startInput.valueAsDate = weekAgo;
    // 设置结束日期为昨天
    endInput.valueAsDate = yesterday;
  }

  // 绑定事件
  document.getElementById('loginForm').addEventListener('submit', handleLogin);
  document.getElementById('registerForm').addEventListener('submit', handleRegister);
  document.getElementById('addAccountForm').addEventListener('submit', handleAddAccount);
  document.getElementById('addGoogleSheetForm').addEventListener('submit', handleAddGoogleSheet);
  document.getElementById('collectForm').addEventListener('submit', handleCollect);
});

// ============ Tab切换 ============
function showTab(tabName, event) {
  // 切换按钮状态
  document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
  if (event && event.target) {
    event.target.classList.add('active');
  }

  // 切换内容
  document.getElementById('loginTab').classList.remove('active');
  document.getElementById('registerTab').classList.remove('active');

  if (tabName === 'login') {
    document.getElementById('loginTab').classList.add('active');
  } else {
    document.getElementById('registerTab').classList.add('active');
  }
}

// ============ 用户认证 ============

// 处理注册
async function handleRegister(e) {
  e.preventDefault();

  const username = document.getElementById('registerUsername').value;
  const email = document.getElementById('registerEmail').value;
  const password = document.getElementById('registerPassword').value;
  const invitationCode = document.getElementById('registerInvitationCode').value.trim();

  if (!invitationCode) {
    showMessage('registerStatus', '请输入邀请码', 'error');
    return;
  }

  try {
    const response = await fetch(`${API_BASE}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, email, password, invitation_code: invitationCode }),
    });

    const result = await response.json();

    if (result.success) {
      // 注册成功，但需要等待审核，所以不自动登录
      showMessage('registerStatus', result.message || '注册成功，请等待管理员审核通过后即可登录', 'success');
      
      // 清空表单
      document.getElementById('registerForm').reset();
      
      // 3秒后切换到登录标签
      setTimeout(() => {
        // 手动切换标签
        document.querySelectorAll('.tab-btn').forEach(btn => {
          if (btn.textContent.includes('登录')) {
            btn.classList.add('active');
          } else {
            btn.classList.remove('active');
          }
        });
        document.getElementById('loginTab').classList.add('active');
        document.getElementById('registerTab').classList.remove('active');
        showMessage('loginStatus', '请等待管理员审核通过后再登录', 'info');
      }, 3000);
    } else {
      showMessage('registerStatus', result.message, 'error');
    }
  } catch (error) {
    showMessage('registerStatus', '网络请求失败: ' + error.message, 'error');
  }
}

// 处理登录
async function handleLogin(e) {
  e.preventDefault();

  const email = document.getElementById('loginEmail').value;
  const password = document.getElementById('loginPassword').value;

  try {
    const response = await fetch(`${API_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });

    const result = await response.json();

    if (result.success) {
      authToken = result.data.token;
      currentUser = result.data.user;

      localStorage.setItem('authToken', authToken);
      localStorage.setItem('token', authToken); // 兼容超管页面

      showMessage('loginStatus', '登录成功！正在跳转...', 'success');

      setTimeout(() => {
        // 根据用户角色跳转
        if (currentUser.role === 'super_admin') {
          window.location.href = '/admin.html';
        } else {
          showAppSection();
        }
      }, 1000);
    } else {
      showMessage('loginStatus', result.message, 'error');
    }
  } catch (error) {
    showMessage('loginStatus', '网络请求失败: ' + error.message, 'error');
  }
}

// 加载用户信息
async function loadUserProfile() {
  try {
    const response = await fetch(`${API_BASE}/auth/me`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });

    const result = await response.json();

    if (result.success) {
      currentUser = result.data;
      // 更新所有用户显示位置
      const currentUserEl = document.getElementById('currentUser');
      const sidebarCurrentUserEl = document.getElementById('sidebarCurrentUser');
      const rankingCurrentUserEl = document.getElementById('rankingCurrentUser');
      if (currentUserEl) currentUserEl.textContent = currentUser.username || currentUser.email;
      if (sidebarCurrentUserEl) sidebarCurrentUserEl.textContent = currentUser.username || currentUser.email;
      if (rankingCurrentUserEl) rankingCurrentUserEl.textContent = currentUser.username || currentUser.email;
      
      // 根据用户角色跳转
      if (currentUser.role === 'super_admin') {
        window.location.href = '/admin.html';
      } else {
        showAppSection();
      }
    } else {
      // Token无效，清除并返回登录页
      logout();
    }
  } catch (error) {
    console.error('加载用户信息失败:', error);
    logout();
  }
}

// 退出登录
function logout() {
  authToken = null;
  currentUser = null;
  localStorage.removeItem('authToken');

  document.getElementById('authSection').style.display = 'block';
  document.getElementById('appSection').style.display = 'none';
}

// 显示应用主页面
function showAppSection() {
  document.getElementById('authSection').style.display = 'none';
  document.getElementById('appSection').style.display = 'block';
  document.getElementById('currentUser').textContent = currentUser.username;

  loadPlatformAccounts();
  loadGoogleSheets();

  // 默认显示数据采集面板
  showSection('dashboard');
}

// ============ 侧边栏导航切换 ============
function showSection(sectionName, event) {
  // 阻止默认链接跳转
  if (event) {
    event.preventDefault();
  }

  // 更新侧边栏激活状态
  document.querySelectorAll('.nav-item').forEach(item => {
    item.classList.remove('active');
  });
  if (event && event.currentTarget) {
    event.currentTarget.classList.add('active');
  }

  // 隐藏所有内容区域
  document.querySelectorAll('.content-section').forEach(section => {
    section.style.display = 'none';
  });

  // 显示对应的内容区域
  let pageTitle = '';
  switch(sectionName) {
    case 'dashboard':
      document.getElementById('dashboardSection').style.display = 'block';
      pageTitle = '数据采集';
      break;
    case 'accounts':
      document.getElementById('accountsSection').style.display = 'block';
      pageTitle = '平台账号管理';
      break;
    case 'sheets':
      document.getElementById('sheetsSection').style.display = 'block';
      pageTitle = '谷歌表格管理';
      break;
    case 'settlement':
      document.getElementById('settlementSection').style.display = 'block';
      pageTitle = '结算查询';
      // 初始化结算查询模块
      initSettlementModule();
      break;
    case 'ranking':
      document.getElementById('rankingSection').style.display = 'block';
      pageTitle = '推荐榜单';
      // 加载推荐榜单数据
      loadTopAdsRanking();
      break;
  }

  // 更新页面标题
  const pageTitleEl = document.getElementById('pageTitle');
  if (pageTitleEl) {
    pageTitleEl.textContent = pageTitle;
  }
}

// ============ 平台账号管理 ============

// 加载平台账号列表
async function loadPlatformAccounts() {
  try {
    const response = await fetch(`${API_BASE}/platform-accounts`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });

    const result = await response.json();

    if (result.success) {
      platformAccounts = result.data;
      renderAccountsList();
    }
  } catch (error) {
    console.error('加载平台账号失败:', error);
  }
}

// 渲染账号列表
function renderAccountsList() {
  console.log('renderAccountsList 被调用, platformAccounts:', platformAccounts);
  const container = document.getElementById('accountsList');

  if (platformAccounts.length === 0) {
    console.log('没有平台账号');
    container.innerHTML = '<p style="color: #999;">暂无平台账号，请先添加</p>';
    document.getElementById('collectSection').style.display = 'none';
    return;
  }

  // 默认全选所有账号
  selectedAccountIds = platformAccounts.map(a => a.id);
  console.log('默认全选账号, selectedAccountIds:', selectedAccountIds);

  container.innerHTML = `
    <div style="margin-bottom: 15px;">
      <button onclick="selectAllAccounts()" class="btn-secondary">全选</button>
      <button onclick="deselectAllAccounts()" class="btn-secondary" style="margin-left: 10px;">取消全选</button>
    </div>
  ` + platformAccounts
    .map(
      account => `
    <div class="account-item" data-account-id="${account.id}">
      <div class="account-info">
        <label style="display: flex; align-items: center; cursor: pointer;">
          <input type="checkbox"
                 class="account-checkbox"
                 value="${account.id}"
                 onchange="toggleAccountSelection(${account.id})"
                 checked
                 style="width: 18px; height: 18px; margin-right: 12px; cursor: pointer;">
          <div>
            <span class="platform-badge">${account.platform}</span>
            <strong>${account.account_name}</strong>
            ${account.affiliate_name ? `<span style="background: #28a745; color: white; padding: 2px 8px; border-radius: 3px; font-size: 11px; margin-left: 8px; font-weight: bold;">${account.affiliate_name}</span>` : ''}
            <div style="font-size: 12px; color: #999; margin-top: 5px;">
              添加于 ${new Date(account.created_at).toLocaleDateString()}
            </div>
          </div>
        </label>
      </div>
      <div class="account-actions">
        <button onclick="deleteAccount(${account.id})" class="btn-danger">删除</button>
      </div>
    </div>
  `
    )
    .join('');

  // 显示采集区域
  document.getElementById('collectSection').style.display = 'block';

  // 更新选择状态UI
  updateSelectionUI();
}

// 切换账号选择状态
function toggleAccountSelection(accountId) {
  // 确保accountId是数字类型
  const id = typeof accountId === 'string' ? parseInt(accountId) : accountId;
  const index = selectedAccountIds.indexOf(id);
  if (index > -1) {
    selectedAccountIds.splice(index, 1);
  } else {
    selectedAccountIds.push(id);
  }
  console.log('当前选中的账号IDs:', selectedAccountIds); // 调试日志
  updateSelectionUI();
}

// 全选账号
function selectAllAccounts() {
  selectedAccountIds = platformAccounts.map(a => a.id);
  document.querySelectorAll('.account-checkbox').forEach(cb => {
    cb.checked = true;
  });
  updateSelectionUI();
}

// 取消全选
function deselectAllAccounts() {
  selectedAccountIds = [];
  document.querySelectorAll('.account-checkbox').forEach(cb => {
    cb.checked = false;
  });
  updateSelectionUI();
}

// 更新选择状态UI
function updateSelectionUI() {
  const count = selectedAccountIds.length;
  console.log('updateSelectionUI 被调用，选中账号数:', count, 'IDs:', selectedAccountIds);

  if (count > 0) {
    document.getElementById('collectSection').style.display = 'block';

    const accounts = platformAccounts
      .filter(a => selectedAccountIds.includes(a.id))
      .map(a => `${a.platform}-${a.account_name}`)
      .join(', ');

    console.log('显示已选择消息:', `已选择 ${count} 个账号: ${accounts}`);
    showMessage('collectStatus', `已选择 ${count} 个账号: ${accounts}`, 'info');
  } else {
    showMessage('collectStatus', '请选择至少一个平台账号', 'error');
  }
}

// 显示添加账号弹窗
function showAddAccountModal() {
  document.getElementById('addAccountModal').style.display = 'block';
  // 根据默认选中的平台（linkhaitao）初始化字段显示状态
  toggleApiTokenField();
}

// 关闭添加账号弹窗
function closeAddAccountModal() {
  document.getElementById('addAccountModal').style.display = 'none';
  document.getElementById('addAccountForm').reset();
  document.getElementById('addAccountStatus').className = 'status-message';
  document.getElementById('addAccountStatus').textContent = '';
  // 重置字段显示状态（恢复密码显示，隐藏Token）
  document.getElementById('passwordGroup').style.display = 'block';
  document.getElementById('apiTokenGroup').style.display = 'none';
}

// 切换API Token字段显示/隐藏，同时控制密码字段
function toggleApiTokenField() {
  const platform = document.getElementById('platformSelect').value;
  const passwordGroup = document.getElementById('passwordGroup');
  const passwordInput = document.getElementById('accountPassword');
  const apiTokenGroup = document.getElementById('apiTokenGroup');
  const apiTokenInput = document.getElementById('apiToken');
  const apiTokenHint = document.getElementById('apiTokenHint');

  // LB、RW、LH、PM平台都使用API Token
  if (platform === 'linkbux' || platform === 'rewardoo' || platform === 'linkhaitao' || platform === 'partnermatic') {
    // 隐藏密码，显示Token（必填）
    passwordGroup.style.display = 'none';
    passwordInput.required = false;
    passwordInput.value = '';

    apiTokenGroup.style.display = 'block';
    apiTokenInput.required = true;

    // 根据平台显示不同的提示文字
    if (platform === 'linkhaitao') {
      apiTokenHint.textContent = 'LinkHaitao平台使用API Token采集，无需密码（在平台后台获取）';
    } else if (platform === 'partnermatic') {
      apiTokenHint.textContent = 'PartnerMatic平台使用API Token采集，无需密码（在平台后台获取）';
    } else if (platform === 'linkbux') {
      apiTokenHint.textContent = 'LinkBux平台使用API Token采集，无需密码（在平台后台获取）';
    } else if (platform === 'rewardoo') {
      apiTokenHint.textContent = 'Rewardoo平台使用API Token采集，无需密码（在平台后台获取）';
    }
  } else {
    // 其他平台：显示密码，隐藏Token
    passwordGroup.style.display = 'block';
    passwordInput.required = true;

    apiTokenGroup.style.display = 'none';
    apiTokenInput.required = false;
    apiTokenInput.value = '';
  }
}

// 处理添加账号
async function handleAddAccount(e) {
  e.preventDefault();

  const platform = document.getElementById('platformSelect').value;
  const accountName = document.getElementById('accountName').value;
  const accountPassword = document.getElementById('accountPassword').value;
  const affiliateName = document.getElementById('affiliateName').value.trim();
  const apiToken = document.getElementById('apiToken').value.trim();

  // 构建请求体
  const requestBody = {
    platform,
    accountName,
    accountPassword,
    affiliateName
  };

  // 如果是LB、RW、LH、PM平台，添加API Token
  if ((platform === 'linkbux' || platform === 'rewardoo' || platform === 'linkhaitao' || platform === 'partnermatic') && apiToken) {
    requestBody.apiToken = apiToken;
  }

  try {
    const response = await fetch(`${API_BASE}/platform-accounts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify(requestBody),
    });

    const result = await response.json();

    if (result.success) {
      showMessage('addAccountStatus', '添加成功！', 'success');

      setTimeout(() => {
        closeAddAccountModal();
        loadPlatformAccounts();
      }, 1000);
    } else {
      showMessage('addAccountStatus', result.message, 'error');
    }
  } catch (error) {
    showMessage('addAccountStatus', '网络请求失败: ' + error.message, 'error');
  }
}

// 删除账号
async function deleteAccount(accountId) {
  if (!confirm('确定要删除这个平台账号吗？')) return;

  try {
    const response = await fetch(`${API_BASE}/platform-accounts/${accountId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${authToken}` },
    });

    const result = await response.json();

    if (result.success) {
      alert('删除成功');

      // 从已选列表中移除
      const index = selectedAccountIds.indexOf(accountId);
      if (index > -1) {
        selectedAccountIds.splice(index, 1);
      }

      loadPlatformAccounts();

      // 如果没有任何选中的账号，隐藏采集区域
      if (selectedAccountIds.length === 0) {
        document.getElementById('collectSection').style.display = 'none';
      }
    } else {
      alert('删除失败: ' + result.message);
    }
  } catch (error) {
    alert('网络请求失败: ' + error.message);
  }
}

// ============ 数据采集 ============

// 处理数据采集（支持多账号）
async function handleCollect(e) {
  e.preventDefault();

  if (selectedAccountIds.length === 0) {
    showMessage('collectStatus', '请先选择至少一个平台账号', 'error');
    return;
  }

  const startDate = document.getElementById('startDate').value;
  const endDate = document.getElementById('endDate').value;

  const submitBtn = e.target.querySelector('button[type="submit"]');
  const btnText = document.getElementById('collectBtnText');
  const spinner = document.getElementById('collectSpinner');

  submitBtn.disabled = true;
  btnText.textContent = '采集中...';
  spinner.style.display = 'inline-block';

  document.getElementById('statsSection').style.display = 'none';

  try {
    const totalAccounts = selectedAccountIds.length;
    showMessage(
      'collectStatus',
      `正在采集 ${totalAccounts} 个账号的数据...（每个账号约需10-30秒）`,
      'info'
    );

    // 存储所有账号的订单数据
    const allOrders = [];
    let successCount = 0;
    let failCount = 0;
    let totalOrdersCount = 0;  // 实际入库的订单数（新增+更新）
    let totalProcessedCount = 0;  // 总处理数（新增+更新+跳过）

    // 循环采集每个账号
    for (let i = 0; i < selectedAccountIds.length; i++) {
      const accountId = selectedAccountIds[i];
      const account = platformAccounts.find(a => a.id === accountId);

      showMessage(
        'collectStatus',
        `[${i + 1}/${totalAccounts}] 正在采集 ${account.platform} - ${account.account_name}...`,
        'info'
      );

      try {
        const response = await fetch(`${API_BASE}/collect-orders`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${authToken}`,
          },
          body: JSON.stringify({
            platformAccountId: accountId,
            startDate,
            endDate,
          }),
        });

        // 检查 HTTP 响应状态
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const result = await response.json();

        // 添加调试日志
        console.log(`[采集] ${account.account_name} 响应:`, result);

        if (result.success && result.data && result.data.orders) {
          allOrders.push(...result.data.orders);

          // 计算实际入库数（新增+更新）和总处理数（新增+更新+跳过）
          const stats = result.data.stats || {};
          const savedCount = (stats.new || 0) + (stats.updated || 0);  // 实际入库数
          const processedCount = stats.total || result.data.orders.length || 0;  // 总处理数

          totalOrdersCount += savedCount;
          totalProcessedCount += processedCount;
          successCount++;

          // 显示详细的采集统计
          let statusMsg = `[${i + 1}/${totalAccounts}] ✅ ${account.account_name} - ${result.message}`;

          if (stats) {
            const details = [];
            if (stats.new > 0) details.push(`新增${stats.new}条`);
            if (stats.updated > 0) details.push(`更新${stats.updated}条`);
            if (stats.skipped > 0) details.push(`跳过${stats.skipped}条`);
            if (details.length > 0) {
              statusMsg += ` (${details.join('，')})`;
            }
          }

          showMessage('collectStatus', statusMsg, 'success');
        } else {
          failCount++;
          // 显示更详细的错误信息
          let errorMsg = `[${i + 1}/${totalAccounts}] ❌ ${account.account_name} 采集失败`;
          if (result.message) {
            errorMsg += `: ${result.message}`;
          } else if (result.data && !result.data.orders) {
            errorMsg += `: 返回数据格式不正确（缺少orders字段）`;
          } else {
            errorMsg += `: 未知错误`;
          }
          console.error(`[采集失败] ${account.account_name}:`, result);
          showMessage('collectStatus', errorMsg, 'error');
        }
      } catch (error) {
        failCount++;
        showMessage(
          'collectStatus',
          `[${i + 1}/${totalAccounts}] ❌ ${account.account_name} 网络请求失败: ${error.message}`,
          'error'
        );
      }

      // 每个账号之间延迟1秒，避免请求过快
      if (i < selectedAccountIds.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    // 显示最终结果
    if (successCount > 0) {
      // 构建详细的采集结果消息
      let finalMsg = `🎉 采集完成！成功: ${successCount}个账号，失败: ${failCount}个账号`;
      if (totalProcessedCount > totalOrdersCount) {
        // 有跳过的订单，显示更详细的信息
        const skippedCount = totalProcessedCount - totalOrdersCount;
        finalMsg += `，实际入库 ${totalOrdersCount} 条（查询到 ${totalProcessedCount} 条，跳过 ${skippedCount} 条重复订单）`;
      } else {
        finalMsg += `，共采集 ${totalOrdersCount} 条订单`;
      }

      showMessage('collectStatus', finalMsg, 'success');

      // 从数据库查询该日期范围内的统计数据（而不是仅统计本次采集的数据）
      await fetchAndDisplayStats(startDate, endDate);
      calculateAndDisplayMerchantSummary(allOrders);
    } else {
      showMessage('collectStatus', '❌ 所有账号采集均失败，请检查账号配置或网络连接', 'error');
    }
  } catch (error) {
    showMessage('collectStatus', '采集过程出错: ' + error.message, 'error');
  } finally {
    submitBtn.disabled = false;
    btnText.textContent = '开始采集';
    spinner.style.display = 'none';
  }
}

// 从数据库查询并显示统计数据
async function fetchAndDisplayStats(startDate, endDate) {
  try {
    console.log('📊 开始获取统计数据，日期范围:', startDate, '至', endDate);
    console.log('📊 选中的账号IDs:', selectedAccountIds);
    
    // 如果选中了多个账号，需要分别查询然后累加
    let totalOrders = 0;
    let totalBudget = 0;
    let totalCommission = 0;

    if (selectedAccountIds.length === 0) {
      // 没有选中账号，查询所有订单
      console.log('📊 没有选中账号，查询所有订单');
      const params = new URLSearchParams({ startDate, endDate });
      const response = await fetch(`${API_BASE}/stats?${params.toString()}`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      const result = await response.json();
      
      console.log('📊 统计数据API响应:', result);

      if (result.success && result.data) {
        totalOrders = result.data.total_orders || 0;
        totalBudget = result.data.total_budget || 0;
        totalCommission = result.data.total_commission || 0;
        console.log('📊 统计数据:', { totalOrders, totalBudget, totalCommission });
      }
    } else {
      // 为每个选中的账号分别查询统计数据，然后累加
      console.log(`📊 为 ${selectedAccountIds.length} 个账号分别查询统计数据`);
      for (const accountId of selectedAccountIds) {
        const params = new URLSearchParams({
          startDate,
          endDate,
          platformAccountId: accountId
        });

        const response = await fetch(`${API_BASE}/stats?${params.toString()}`, {
          headers: { Authorization: `Bearer ${authToken}` },
        });

        const result = await response.json();
        
        console.log(`📊 账号 ${accountId} 统计数据:`, result);

        if (result.success && result.data) {
          const orders = result.data.total_orders || 0;
          const budget = result.data.total_budget || 0;
          const commission = result.data.total_commission || 0;
          
          console.log(`📊 账号 ${accountId} 数据:`, { orders, budget, commission });
          
          totalOrders += orders;
          totalBudget += budget;
          totalCommission += commission;
        } else {
          console.warn(`⚠️ 账号 ${accountId} 统计数据获取失败:`, result.message);
        }
      }
      
      console.log('📊 累计统计数据:', { totalOrders, totalBudget, totalCommission });
    }

    // 显示统计数据
    const totalOrdersEl = document.getElementById('totalOrders');
    const totalBudgetEl = document.getElementById('totalBudget');
    const totalCommissionEl = document.getElementById('totalCommission');
    const statsSectionEl = document.getElementById('statsSection');
    
    if (!totalOrdersEl || !totalBudgetEl || !totalCommissionEl) {
      console.error('❌ 找不到统计元素:', {
        totalOrders: !!totalOrdersEl,
        totalBudget: !!totalBudgetEl,
        totalCommission: !!totalCommissionEl
      });
      return;
    }
    
    totalOrdersEl.textContent = totalOrders;
    totalBudgetEl.textContent = '$' + totalBudget.toFixed(2);
    totalCommissionEl.textContent = '$' + totalCommission.toFixed(2);

    console.log('📊 已更新统计卡片显示:', { totalOrders, totalBudget, totalCommission });
    if (statsSectionEl) {
      statsSectionEl.style.display = 'block';
    }
  } catch (error) {
    console.error('❌ 获取统计数据失败:', error);
  }
}

// 显示统计数据（保留用于兼容性）
function displayStats(total) {
  document.getElementById('totalOrders').textContent = total.items || '0';
  document.getElementById('totalBudget').textContent = '$' + (total.total_budget || '0');
  document.getElementById('totalCommission').textContent = '$' + (total.total_aff_ba || '0');

  document.getElementById('statsSection').style.display = 'block';
}

// 存储操作建议的展开状态
const expandedAnalysisDetails = new Set();

// 切换操作建议详情展开/收起
function toggleAnalysisDetail(analysisId) {
  const detailElement = document.getElementById(`analysis-detail-${analysisId}`);
  if (!detailElement) return;
  
  if (expandedAnalysisDetails.has(analysisId)) {
    detailElement.style.display = 'none';
    expandedAnalysisDetails.delete(analysisId);
  } else {
    detailElement.style.display = 'block';
    expandedAnalysisDetails.add(analysisId);
  }
}

// 获取操作建议显示文本
function getSuggestionDisplay(analysis, rowId) {
  if (!analysis) {
    return '<span style="color: #9ca3af; font-size: 11px;">-</span>';
  }

  const { suggestion, confidence, reason, budgetIncrease } = analysis;
  
  // 生成唯一ID用于展开功能
  const analysisId = `analysis-${rowId}`;
  const isExpanded = expandedAnalysisDetails.has(analysisId);
  
  let color = '#9ca3af'; // 默认灰色
  let bgColor = 'rgba(156, 163, 175, 0.1)';
  let icon = '⚪'; // 默认图标
  
  if (suggestion === '建议暂停') {
    color = '#ef4444';
    bgColor = 'rgba(239, 68, 68, 0.1)';
    icon = '🛑';
  } else if (suggestion === '建议增加预算') {
    color = '#10b981';
    bgColor = 'rgba(16, 185, 129, 0.1)';
    icon = '📈';
  } else if (suggestion === '建议优化') {
    color = '#f59e0b';
    bgColor = 'rgba(245, 158, 11, 0.1)';
    icon = '⚠️';
  } else if (suggestion === '建议维持') {
    color = '#3b82f6';
    bgColor = 'rgba(59, 130, 246, 0.1)';
    icon = '✓';
  } else if (suggestion === '继续监测') {
    color = '#6b7280';
    bgColor = 'rgba(107, 114, 128, 0.1)';
    icon = '⏳';
  }
  
  let displayText = suggestion;
  if (budgetIncrease !== null && budgetIncrease !== undefined) {
    displayText += ` +${budgetIncrease}%`;
  }
  
  const confidenceBadge = confidence === '高' ? '🟢' : confidence === '中' ? '🟡' : '⚪';
  
  // 截取简短原因（最多35个字符）
  const shortReason = reason ? (reason.length > 35 ? reason.substring(0, 35) + '...' : reason) : suggestion;
  
  // 参数明细
  let metricsHtml = '';
  if (analysis.metrics) {
    const roas = (analysis.metrics.roas !== undefined && analysis.metrics.roas !== null) ? analysis.metrics.roas.toFixed(2) : '-';
    const lostIS = (analysis.metrics.lostISBudget !== undefined && analysis.metrics.lostISBudget !== null) ? analysis.metrics.lostISBudget.toFixed(2) + '%' : '-';
    const trend = analysis.metrics.trend || '-';
    const incROAS = analysis.metrics.incrementalAnalysis && 
      (analysis.metrics.incrementalAnalysis.incrementalROAS !== undefined && analysis.metrics.incrementalAnalysis.incrementalROAS !== null)
      ? analysis.metrics.incrementalAnalysis.incrementalROAS.toFixed(2)
      : '-';
    const ctr = (analysis.metrics.ctr !== undefined && analysis.metrics.ctr !== null) ? analysis.metrics.ctr.toFixed(2) + '%' : '-';
    const cpc = (analysis.metrics.cpc !== undefined && analysis.metrics.cpc !== null) ? '$' + analysis.metrics.cpc.toFixed(4) : '-';
    const cvr = (analysis.metrics.cvr !== undefined && analysis.metrics.cvr !== null) ? analysis.metrics.cvr.toFixed(2) + '%' : '-';
    const volatility = analysis.metrics.volatility || '-';

    metricsHtml = `
      <div style="margin-top: 6px; padding-top: 6px; border-top: 1px solid rgba(255,255,255,0.1);">
        <div style="color:#9ca3af; margin-bottom:4px;">依据参数：</div>
        <div style="display:grid; grid-template-columns: repeat(2, minmax(100px, 1fr)); gap:6px; color:#d1d5db;">
          <div>ROAS：<strong>${roas}</strong></div>
          <div>因预算丢失展示：<strong>${lostIS}</strong></div>
          <div>趋势：<strong>${trend}</strong></div>
          <div>增量ROAS：<strong>${incROAS}</strong></div>
          <div>CTR：<strong>${ctr}</strong></div>
          <div>CPC：<strong>${cpc}</strong></div>
          <div>CVR：<strong>${cvr}</strong></div>
          <div>波动性：<strong>${volatility}</strong></div>
          ${budgetIncrease !== null && budgetIncrease !== undefined ? `<div>建议增幅：<strong>+${budgetIncrease}%</strong></div>` : ''}
        </div>
      </div>`;
  }

  return `
    <div style="display: flex; flex-direction: column; gap: 4px; align-items: flex-start;">
      <div style="display: flex; align-items: center; gap: 4px;">
        <span style="
          display: inline-flex;
          align-items: center;
          gap: 4px;
          padding: 4px 8px;
          border-radius: 4px;
          background: ${bgColor};
          color: ${color};
          font-size: 11px;
          font-weight: 600;
        ">
          ${icon} ${displayText} ${confidenceBadge}
        </span>
      </div>
      <div style="font-size: 10px; color: #9ca3af; line-height: 1.3; max-width: 100%;">
        ${shortReason}
      </div>
      <button onclick="event.stopPropagation(); toggleAnalysisDetail('${analysisId}')" 
              style="
                background: transparent;
                border: 1px solid ${color};
                color: ${color};
                padding: 2px 6px;
                border-radius: 3px;
                font-size: 10px;
                cursor: pointer;
                margin-top: 2px;
              ">
        ${isExpanded ? '收起详情' : '查看详情'}
      </button>
      <div id="analysis-detail-${analysisId}" 
           style="display: ${isExpanded ? 'block' : 'none'}; 
                  margin-top: 6px; 
                  padding: 8px; 
                  background: rgba(0, 0, 0, 0.3); 
                  border-radius: 4px; 
                  font-size: 10px; 
                  line-height: 1.5;
                  border-left: 2px solid ${color};">
        <div style="margin-bottom: 4px;"><strong style="color: ${color};">详细建议：</strong></div>
        <div style="color: #d1d5db; margin-bottom: 4px;">${reason || suggestion}</div>
        <div style="margin-top: 6px; padding-top: 6px; border-top: 1px solid rgba(255,255,255,0.1);">
          <div style="color: #9ca3af;">信心等级：<strong style="color: ${confidence === '高' ? '#10b981' : confidence === '中' ? '#f59e0b' : '#6b7280'}">${confidence}</strong></div>
        </div>
        ${metricsHtml}
      </div>
    </div>
  `;
}

// 处理状态筛选变化
function handleStatusFilterChange() {
  // 重新加载商家汇总数据
  calculateAndDisplayMerchantSummary([]);
}

// 计算并显示本次采集的商家汇总（改为从后端API获取，包含广告数据）
async function calculateAndDisplayMerchantSummary(orders) {
  // 获取日期范围（从采集表单）
  const startDate = document.getElementById('startDate').value;
  const endDate = document.getElementById('endDate').value;

  // 构建查询参数：只包含选中的账号
  const params = new URLSearchParams({
    startDate,
    endDate
  });

  // 如果选中了账号，添加平台账号ID过滤（只查询选中账号的数据）
  if (selectedAccountIds.length > 0) {
    // 传递逗号分隔的账号ID列表
    params.append('platformAccountIds', selectedAccountIds.join(','));
  }

  // 添加状态筛选参数
  const statusFilter = document.querySelector('input[name="showStatus"]:checked');
  if (statusFilter && statusFilter.value !== 'all') {
    params.append('showStatus', statusFilter.value);
  }

  try {
    // 调用后端API获取商家汇总（包含广告数据）
    const response = await fetch(`${API_BASE}/merchant-summary?${params.toString()}`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });

    const result = await response.json();

    console.log('📊 商家汇总API返回:', { success: result.success, dataLength: result.data?.length, message: result.message });

    if (result.success) {
      if (result.data && result.data.length > 0) {
        console.log('📊 商家汇总数据:', result.data.length, '条记录');
        displayMerchantSummary(result.data);
      } else {
        console.warn('⚠️ 商家汇总数据为空');
        displayMerchantSummary([]);
      }
      // 不再自动加载推荐榜单（用户通过侧边栏访问）
    } else {
      console.error('获取商家汇总失败:', result.message);
      // 降级方案：使用前端计算（不含广告数据）
      const merchantMap = new Map();

      orders.forEach(order => {
        const mcid = order.mcid;
        if (!merchantMap.has(mcid)) {
          merchantMap.set(mcid, {
            merchant_id: mcid,
            merchant_name: order.sitename,
            order_count: 0,
            total_amount: 0,
            total_commission: 0,
            pending_commission: 0,
            confirmed_commission: 0,
            rejected_commission: 0,
          });
        }

        const merchant = merchantMap.get(mcid);
        merchant.order_count++;
        merchant.total_amount += parseFloat(order.amount || 0);

        const commission = parseFloat(order.total_cmsn || 0);
        merchant.total_commission += commission;

        if (order.status === 'Pending') {
          merchant.pending_commission += commission;
        } else if (order.status === 'Approved') {
          merchant.confirmed_commission += commission;
        } else if (order.status === 'Rejected') {
          merchant.rejected_commission += commission;
        }
      });

      const summary = Array.from(merchantMap.values());
      summary.sort((a, b) => b.total_commission - a.total_commission);

      displayMerchantSummary(summary);
    }
  } catch (error) {
    console.error('调用商家汇总API失败:', error);
    // 降级方案同上
    displayMerchantSummary([]);
  }
}

// 显示商家汇总表格（包含营销指标：CR、EPC、CPC、ROI）
function displayMerchantSummary(summary) {
  const tbody = document.getElementById('merchantTableBody');
  tbody.innerHTML = '';
  
  // 保存当前展开状态，用于重新渲染后恢复
  const previousExpandedRows = new Map(expandedRows);
  expandedRows.clear();

  if (summary.length === 0) {
    tbody.innerHTML = '<tr><td colspan="14" style="text-align: center; color: #999;">暂无数据</td></tr>';
    document.getElementById('merchantSection').style.display = 'block';
    return;
  }

  summary.forEach((merchant, index) => {
    // 处理广告系列名称（完全显示，不截断）
    let campaignDisplay = '-';
    if (merchant.campaign_names) {
      const campaigns = merchant.campaign_names.split(',');
      if (campaigns.length > 1) {
        campaignDisplay = `${campaigns[0]} (共${campaigns.length}个)`;
      } else {
        campaignDisplay = campaigns[0];
      }
    }

    // 计算营销指标
    const clicks = merchant.total_clicks || 0;
    const orders = merchant.order_count || 0;
    const commission = merchant.total_commission || 0;
    const cost = merchant.total_cost || 0;

    // CR (Conversion Rate) = 订单数 / 点击数 * 100%
    const cr = clicks > 0 ? (orders / clicks * 100).toFixed(2) : '0.00';

    // EPC (Earnings Per Click) = 总佣金 / 点击数
    const epc = clicks > 0 ? (commission / clicks).toFixed(2) : '0.00';

    // CPC (Cost Per Click) = 广告费 / 点击数
    const cpc = clicks > 0 ? (cost / clicks).toFixed(2) : '0.00';

    // ROI (Return On Investment) = (总佣金 - 广告费) / 广告费
    let roi = '0.00';
    let roiColor = '#4ade80';  // 默认绿色
    if (cost > 0) {
      const roiValue = ((commission - cost) / cost);
      roi = roiValue.toFixed(2);
      // 🔥 ROI颜色：>=0绿色，<0红色
      roiColor = roiValue >= 0 ? '#4ade80' : '#f87171';
    }

    // 生成行ID（用于展开功能）
    const rowId = `${merchant.merchant_id}_${merchant.affiliate_name}_${merchant.campaign_names}`;
    const isExpanded = expandedRows.has(rowId);
    
    const row = tbody.insertRow();
    row.className = 'merchant-summary-row';
    row.setAttribute('data-row-id', rowId);
    row.style.cursor = 'pointer';
    
    // 为展开图标准备（将图标和排名放在一起）
    const expandIcon = isExpanded ? '▼' : '▶';
    const expandIconColor = isExpanded ? '#3b82f6' : '#9ca3af';
    
    // 获取广告系列状态（活跃/暂停）
    const status = merchant.status || 'active';
    const statusIcon = status === 'active' ? '🟢' : '⚪';
    const statusText = status === 'active' ? '活跃' : '暂停';
    const statusColor = status === 'active' ? '#10b981' : '#9ca3af';
    
    row.innerHTML = `
      <td style="color: #a0a0a0;">
        <span style="color: ${expandIconColor}; font-weight: bold; margin-right: 6px; cursor: pointer; user-select: none;" class="expand-icon" onclick="event.stopPropagation(); toggleRowDetail('${rowId}')" title="${isExpanded ? '收起' : '展开详细数据'}">${expandIcon}</span>
        <span>${index + 1}</span>
      </td>
      <td style="background: rgba(59, 130, 246, 0.1); font-size: 12px; color: #60a5fa;" title="${merchant.campaign_names || '-'}">
        <span style="margin-right: 6px; font-size: 10px;" title="${statusText}">${statusIcon}</span>
        ${campaignDisplay}
      </td>
      <td><strong style="color: #fbbf24;">${merchant.merchant_id || '-'}</strong></td>
      <td style="background: rgba(59, 130, 246, 0.1); color: #93c5fd;">$${(merchant.total_budget || 0).toFixed(2)}</td>
      <td style="background: rgba(59, 130, 246, 0.1); color: #93c5fd;">${(merchant.total_impressions || 0).toLocaleString()}</td>
      <td style="background: rgba(59, 130, 246, 0.1); color: #93c5fd;">${clicks.toLocaleString()}</td>
      <td style="background: rgba(59, 130, 246, 0.1);"><strong style="color: #f87171;">$${cost.toFixed(2)}</strong></td>
      <td style="color: #e5e7eb;">${orders}</td>
      <td><strong style="color: #a78bfa;">$${commission.toFixed(2)}</strong></td>
      <td style="background: rgba(34, 197, 94, 0.1);"><strong style="color: #4ade80;">${cr}%</strong></td>
      <td style="background: rgba(34, 197, 94, 0.1);"><strong style="color: #4ade80;">$${epc}</strong></td>
      <td style="background: rgba(34, 197, 94, 0.1);"><strong style="color: #4ade80;">$${cpc}</strong></td>
      <td style="background: rgba(34, 197, 94, 0.1);"><strong style="color: ${roiColor >= 0 ? '#4ade80' : '#f87171'};">${roi}</strong></td>
      <td style="background: rgba(139, 92, 246, 0.1); text-align: left; padding: 8px;">
        ${getSuggestionDisplay(merchant.analysis, rowId)}
      </td>
    `;
    
    // 保存行数据引用，用于展开功能
    row.merchantData = merchant;
    
    // 为整行添加点击事件（展开/收起）
    row.addEventListener('click', (e) => {
      // 如果点击的是展开图标，已经处理了，不需要再次处理
      if (e.target.classList.contains('expand-icon')) {
        return;
      }
      toggleRowDetail(rowId);
    });
    
    // 立即创建详细数据行（作为"子行"），默认隐藏 - 类似 ul/li 嵌套结构
    const detailRow = tbody.insertRow();
    detailRow.className = 'daily-details-row';
    detailRow.setAttribute('data-detail-row-id', rowId);
    detailRow.style.display = isExpanded ? '' : 'none'; // 默认隐藏
    
    // 创建一个占满所有列的单元格
    const detailCell = detailRow.insertCell(0);
    detailCell.colSpan = 14;
    detailCell.style.padding = '0';
    detailCell.style.backgroundColor = 'transparent';
    
    // 如果需要展开且已有数据，直接渲染；否则显示加载状态或占位
    if (isExpanded && previousExpandedRows.has(rowId) && previousExpandedRows.get(rowId).loaded) {
      const data = previousExpandedRows.get(rowId).data;
      expandedRows.set(rowId, previousExpandedRows.get(rowId));
      row.style.backgroundColor = 'rgba(59, 130, 246, 0.08)';
      row.style.borderLeft = '3px solid #3b82f6';
      row.style.position = 'relative';
      renderDailyDetailsTable(detailRow, data, merchant);
    } else {
      // 占位，等待数据加载
      detailCell.innerHTML = '<div style="padding: 20px; text-align: center; color: #707070; font-size: 12px;">等待加载...</div>';
    }
    
    // 保存详细行的引用到父行
    row.detailRow = detailRow;
  });

  // 计算并显示总体统计数据
  calculateAndDisplayStats(summary);

  // 显示商家section和导出按钮
  document.getElementById('merchantSection').style.display = 'block';
  document.getElementById('exportBtn').style.display = 'inline-flex';
}

// ============ 展开/收起详细数据功能 ============

/**
 * 切换行的展开/收起状态
 */
async function toggleRowDetail(rowId) {
  const tbody = document.getElementById('merchantTableBody');
  const row = tbody.querySelector(`tr[data-row-id="${rowId}"]`);
  
  if (!row) return;
  
  const merchant = row.merchantData;
  if (!merchant) return;
  
  // 获取预先创建的详细行（类似 ul/li 的子元素）
  const detailRow = row.detailRow || tbody.querySelector(`tr[data-detail-row-id="${rowId}"]`);
  
  if (!detailRow) {
    console.error('找不到详细数据行:', rowId);
    return;
  }
  
  // 检查是否已展开（通过 display 样式判断）
  // display 为 'none' 表示隐藏（收起），其他值表示显示（展开）
  const isCurrentlyExpanded = detailRow.style.display !== 'none';
  
  if (isCurrentlyExpanded) {
    // 收起：隐藏详细行（不删除DOM，只隐藏）
    detailRow.style.display = 'none';
    expandedRows.delete(rowId);
    
    // 更新展开图标
    const expandIcon = row.querySelector('.expand-icon');
    if (expandIcon) {
      expandIcon.textContent = '▶';
      expandIcon.style.color = '#9ca3af';
      expandIcon.title = '展开详细数据';
    }
    row.style.backgroundColor = '';
    row.style.borderLeft = '';
  } else {
    // 展开：显示详细行
    detailRow.style.display = '';
    row.style.backgroundColor = 'rgba(59, 130, 246, 0.08)';
    row.style.borderLeft = '3px solid #3b82f6';
    row.style.position = 'relative';
    
    // 更新展开图标
    const expandIcon = row.querySelector('.expand-icon');
    if (expandIcon) {
      expandIcon.textContent = '▼';
      expandIcon.style.color = '#3b82f6';
      expandIcon.title = '收起详细数据';
    }
    
    // 检查是否已加载过数据
    if (expandedRows.has(rowId) && expandedRows.get(rowId).loaded) {
      // 使用缓存的数据，更新详细行内容
      renderDailyDetailsTable(detailRow, expandedRows.get(rowId).data, merchant);
    } else {
      // 加载新数据
      await loadDailyDetails(rowId, merchant);
    }
  }
}

/**
 * 加载按天详细数据
 */
async function loadDailyDetails(rowId, merchant) {
  const tbody = document.getElementById('merchantTableBody');
  const row = tbody.querySelector(`tr[data-row-id="${rowId}"]`);
  if (!row) return;
  
  // 获取预先创建的详细行
  const detailRow = row.detailRow || tbody.querySelector(`tr[data-detail-row-id="${rowId}"]`);
  if (!detailRow) return;
  
  // 显示加载状态
  const cell = detailRow.querySelector('td');
  if (cell) {
    cell.innerHTML = `
      <div style="padding: 40px; text-align: center; color: #93c5fd;">
        <div style="display: inline-block; width: 24px; height: 24px; border: 3px solid rgba(147, 197, 253, 0.2); border-top-color: #93c5fd; border-radius: 50%; animation: spin 0.8s linear infinite;"></div>
        <div style="margin-top: 12px; font-size: 13px;">加载中...</div>
      </div>
    `;
  }
  
  // 获取日期范围
  const startDate = document.getElementById('startDate').value;
  const endDate = document.getElementById('endDate').value;
  
  // 获取广告系列名称（处理多个系列的情况，取第一个）
  let campaignName = merchant.campaign_names;
  if (campaignName && campaignName.includes(',')) {
    // 如果有多个系列，取第一个
    campaignName = campaignName.split(',')[0].trim();
  }
  
  try {
    const params = new URLSearchParams({
      merchantId: merchant.merchant_id,
      campaignName: campaignName,
      affiliateName: merchant.affiliate_name || '',
      startDate: startDate,
      endDate: endDate
    });
    
    const response = await fetch(`${API_BASE}/campaign-daily-details?${params.toString()}`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    
    const result = await response.json();
    
    if (result.success && result.data) {
      // 保存数据到缓存
      expandedRows.set(rowId, {
        loaded: true,
        data: result.data.daily_stats || []
      });
      
      // 更新详细行内容
      renderDailyDetailsTable(detailRow, result.data.daily_stats, merchant);
    } else {
      // 显示错误
      if (cell) {
        cell.innerHTML = `<div style="padding: 30px; text-align: center; color: #f87171; font-size: 13px;">加载失败: ${result.message || '未知错误'}</div>`;
      }
      expandedRows.delete(rowId);
    }
  } catch (error) {
    console.error('加载详细数据失败:', error);
    if (cell) {
      cell.innerHTML = `<div style="padding: 30px; text-align: center; color: #f87171; font-size: 13px;">加载失败: ${error.message}</div>`;
    }
    expandedRows.delete(rowId);
  }
}

/**
 * 渲染按天详细数据表格
 */
function renderDailyDetailsTable(detailRow, dailyData, merchant = null) {
  const cell = detailRow.querySelector('td');
  if (!cell) return;
  
  if (!dailyData || dailyData.length === 0) {
    cell.innerHTML = `<div style="padding: 30px; text-align: center; color: #707070; font-size: 13px;">暂无详细数据</div>`;
    return;
  }
  
  // 简化显示，详细数据就在父行下方，不需要重复显示商家信息
  // 因为用户点击展开的就是这一行的详细数据，归属关系很明确
  let tableHtml = `
    <div style="padding: 12px 16px 16px 48px; position: relative;">
      <!-- 左侧连接线，从父行连接到详细数据，表示层级关系和包含关系 -->
      <div style="position: absolute; left: 24px; top: 0; bottom: 0; width: 2px; background: linear-gradient(to bottom, rgba(59, 130, 246, 0.5), rgba(59, 130, 246, 0.2)); border-radius: 1px;"></div>
      
      <!-- 连接点（圆点），表示从父行展开 -->
      <div style="position: absolute; left: 19px; top: 18px; width: 10px; height: 10px; border-radius: 50%; background: #3b82f6; border: 2px solid #1a1a1a; box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.3); z-index: 1;"></div>
      
      <!-- 标题：按天详细数据 -->
      <div style="font-size: 13px; color: #93c5fd; margin-bottom: 14px; font-weight: 600; display: flex; align-items: center; gap: 8px; padding-left: 20px; padding-top: 4px;">
        <span style="font-size: 16px;">📅</span>
        <span>按天详细数据 (共 ${dailyData.length} 天)</span>
      </div>
      <div style="overflow-x: auto; border-radius: 10px; border: 1px solid rgba(59, 130, 246, 0.25); background: rgba(20, 20, 20, 0.8); margin-left: 16px; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.05);">
        <table class="daily-details-table" style="width: 100%; border-collapse: separate; border-spacing: 0; font-size: 12px; background: transparent;">
          <thead>
            <tr>
              <th style="padding: 12px 14px; text-align: center; font-weight: 700; color: #f3f4f6; font-size: 11px; text-transform: uppercase; letter-spacing: 0.8px; white-space: nowrap; min-width: 70px; border-bottom: 2px solid rgba(59, 130, 246, 0.3); background: linear-gradient(180deg, #1a1a1a 0%, #151515 100%);">日期</th>
              <th style="padding: 12px 14px; text-align: center; font-weight: 700; color: #93c5fd; font-size: 11px; text-transform: uppercase; letter-spacing: 0.8px; white-space: nowrap; min-width: 85px; border-bottom: 2px solid rgba(59, 130, 246, 0.3); background: linear-gradient(180deg, rgba(59, 130, 246, 0.15) 0%, rgba(59, 130, 246, 0.1) 100%);">预算</th>
              <th style="padding: 12px 14px; text-align: center; font-weight: 700; color: #93c5fd; font-size: 11px; text-transform: uppercase; letter-spacing: 0.8px; white-space: nowrap; min-width: 85px; border-bottom: 2px solid rgba(59, 130, 246, 0.3); background: linear-gradient(180deg, rgba(59, 130, 246, 0.15) 0%, rgba(59, 130, 246, 0.1) 100%);">展示</th>
              <th style="padding: 12px 14px; text-align: center; font-weight: 700; color: #93c5fd; font-size: 11px; text-transform: uppercase; letter-spacing: 0.8px; white-space: nowrap; min-width: 75px; border-bottom: 2px solid rgba(59, 130, 246, 0.3); background: linear-gradient(180deg, rgba(59, 130, 246, 0.15) 0%, rgba(59, 130, 246, 0.1) 100%);">点击</th>
              <th style="padding: 12px 14px; text-align: center; font-weight: 700; color: #f87171; font-size: 11px; text-transform: uppercase; letter-spacing: 0.8px; white-space: nowrap; min-width: 85px; border-bottom: 2px solid rgba(59, 130, 246, 0.3); background: linear-gradient(180deg, rgba(59, 130, 246, 0.15) 0%, rgba(59, 130, 246, 0.1) 100%);">广告费</th>
              <th style="padding: 12px 14px; text-align: center; font-weight: 700; color: #f3f4f6; font-size: 11px; text-transform: uppercase; letter-spacing: 0.8px; white-space: nowrap; min-width: 75px; border-bottom: 2px solid rgba(59, 130, 246, 0.3); background: linear-gradient(180deg, #1a1a1a 0%, #151515 100%);">订单数</th>
              <th style="padding: 12px 14px; text-align: center; font-weight: 700; color: #a78bfa; font-size: 11px; text-transform: uppercase; letter-spacing: 0.8px; white-space: nowrap; min-width: 90px; border-bottom: 2px solid rgba(59, 130, 246, 0.3); background: linear-gradient(180deg, #1a1a1a 0%, #151515 100%);">总佣金</th>
              <th style="padding: 12px 14px; text-align: center; font-weight: 700; color: #4ade80; font-size: 11px; text-transform: uppercase; letter-spacing: 0.8px; white-space: nowrap; min-width: 70px; border-bottom: 2px solid rgba(59, 130, 246, 0.3); background: linear-gradient(180deg, rgba(34, 197, 94, 0.15) 0%, rgba(34, 197, 94, 0.1) 100%);">CR</th>
              <th style="padding: 12px 14px; text-align: center; font-weight: 700; color: #4ade80; font-size: 11px; text-transform: uppercase; letter-spacing: 0.8px; white-space: nowrap; min-width: 80px; border-bottom: 2px solid rgba(59, 130, 246, 0.3); background: linear-gradient(180deg, rgba(34, 197, 94, 0.15) 0%, rgba(34, 197, 94, 0.1) 100%);">EPC</th>
              <th style="padding: 12px 14px; text-align: center; font-weight: 700; color: #4ade80; font-size: 11px; text-transform: uppercase; letter-spacing: 0.8px; white-space: nowrap; min-width: 75px; border-bottom: 2px solid rgba(59, 130, 246, 0.3); background: linear-gradient(180deg, rgba(34, 197, 94, 0.15) 0%, rgba(34, 197, 94, 0.1) 100%);">CPC</th>
              <th style="padding: 12px 14px; text-align: center; font-weight: 700; color: #4ade80; font-size: 11px; text-transform: uppercase; letter-spacing: 0.8px; white-space: nowrap; min-width: 70px; border-bottom: 2px solid rgba(59, 130, 246, 0.3); background: linear-gradient(180deg, rgba(34, 197, 94, 0.15) 0%, rgba(34, 197, 94, 0.1) 100%);">ROI</th>
              <th style="padding: 12px 14px; text-align: center; font-weight: 700; color: #fbbf24; font-size: 11px; text-transform: uppercase; letter-spacing: 0.8px; white-space: nowrap; min-width: 130px; border-bottom: 2px solid rgba(59, 130, 246, 0.3); background: linear-gradient(180deg, rgba(251, 191, 36, 0.15) 0%, rgba(251, 191, 36, 0.1) 100%);">因预算而减少的展示份额</th>
              <th style="padding: 12px 14px; text-align: center; font-weight: 700; color: #fbbf24; font-size: 11px; text-transform: uppercase; letter-spacing: 0.8px; white-space: nowrap; min-width: 130px; border-bottom: 2px solid rgba(59, 130, 246, 0.3); background: linear-gradient(180deg, rgba(251, 191, 36, 0.15) 0%, rgba(251, 191, 36, 0.1) 100%);">因评级减少的展示份额</th>
            </tr>
          </thead>
          <tbody>
  `;
  
  dailyData.forEach((day, index) => {
    const date = new Date(day.date);
    const dateStr = `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    const roiColor = day.roi >= 0 ? '#4ade80' : '#f87171';
    const isEven = index % 2 === 0;
    const rowBg = isEven ? 'rgba(255, 255, 255, 0.01)' : 'rgba(255, 255, 255, 0.03)';
    
    tableHtml += `
      <tr style="background: ${rowBg}; border-bottom: 1px solid rgba(59, 130, 246, 0.1); transition: all 0.2s ease;" onmouseover="this.style.background='rgba(59, 130, 246, 0.12)'; this.style.transform='translateX(2px)';" onmouseout="this.style.background='${rowBg}'; this.style.transform='translateX(0)';">
        <td style="padding: 14px; text-align: center; color: #f3f4f6; font-weight: 600; font-size: 12.5px; border-right: 1px solid rgba(59, 130, 246, 0.1);">${dateStr}</td>
        <td style="padding: 14px; text-align: center; color: #93c5fd; font-weight: 600; font-size: 12.5px; background: rgba(59, 130, 246, 0.06); font-family: 'Courier New', monospace; border-right: 1px solid rgba(59, 130, 246, 0.1);">$${(day.budget || 0).toFixed(2)}</td>
        <td style="padding: 14px; text-align: center; color: #60a5fa; font-weight: 500; font-size: 12.5px; background: rgba(59, 130, 246, 0.06); font-family: 'Courier New', monospace; border-right: 1px solid rgba(59, 130, 246, 0.1);">${(day.impressions || 0).toLocaleString()}</td>
        <td style="padding: 14px; text-align: center; color: #60a5fa; font-weight: 500; font-size: 12.5px; background: rgba(59, 130, 246, 0.06); font-family: 'Courier New', monospace; border-right: 1px solid rgba(59, 130, 246, 0.1);">${(day.clicks || 0).toLocaleString()}</td>
        <td style="padding: 14px; text-align: center; color: #f87171; font-weight: 600; font-size: 12.5px; background: rgba(59, 130, 246, 0.06); font-family: 'Courier New', monospace; border-right: 1px solid rgba(59, 130, 246, 0.1);">$${(day.cost || 0).toFixed(2)}</td>
        <td style="padding: 14px; text-align: center; color: #e5e7eb; font-weight: 600; font-size: 12.5px; font-family: 'Courier New', monospace; border-right: 1px solid rgba(59, 130, 246, 0.1);">${day.order_count || 0}</td>
        <td style="padding: 14px; text-align: center; color: #c084fc; font-weight: 600; font-size: 12.5px; font-family: 'Courier New', monospace; border-right: 1px solid rgba(59, 130, 246, 0.1);">$${(day.commission || 0).toFixed(2)}</td>
        <td style="padding: 14px; text-align: center; color: #34d399; font-weight: 600; font-size: 12.5px; background: rgba(34, 197, 94, 0.08); font-family: 'Courier New', monospace; border-right: 1px solid rgba(59, 130, 246, 0.1);">${(day.cr || 0).toFixed(2)}%</td>
        <td style="padding: 14px; text-align: center; color: #34d399; font-weight: 600; font-size: 12.5px; background: rgba(34, 197, 94, 0.08); font-family: 'Courier New', monospace; border-right: 1px solid rgba(59, 130, 246, 0.1);">$${(day.epc || 0).toFixed(2)}</td>
        <td style="padding: 14px; text-align: center; color: #34d399; font-weight: 600; font-size: 12.5px; background: rgba(34, 197, 94, 0.08); font-family: 'Courier New', monospace; border-right: 1px solid rgba(59, 130, 246, 0.1);">$${(day.cpc || 0).toFixed(2)}</td>
        <td style="padding: 14px; text-align: center; color: ${roiColor}; font-weight: 700; font-size: 12.5px; background: rgba(34, 197, 94, 0.08); font-family: 'Courier New', monospace; border-right: 1px solid rgba(59, 130, 246, 0.1);">${(day.roi || 0).toFixed(2)}</td>
        <td style="padding: 14px; text-align: center; color: #fbbf24; font-weight: 600; font-size: 12.5px; background: rgba(251, 191, 36, 0.1); font-family: 'Courier New', monospace; border-right: 1px solid rgba(59, 130, 246, 0.1);">${((day.lost_is_budget || 0) * 100).toFixed(2)}%</td>
        <td style="padding: 14px; text-align: center; color: #fbbf24; font-weight: 600; font-size: 12.5px; background: rgba(251, 191, 36, 0.1); font-family: 'Courier New', monospace;">${((day.lost_is_rank || 0) * 100).toFixed(2)}%</td>
      </tr>
    `;
  });
  
  tableHtml += `
          </tbody>
        </table>
      </div>
    </div>
  `;
  
  cell.innerHTML = tableHtml;
}

// 计算并显示总体统计数据
function calculateAndDisplayStats(summary) {
  console.log('📊 前端接收到的商家汇总数据:', summary);
  
  if (summary.length === 0) {
    // 如果没有数据，显示0
    document.getElementById('totalAdSpend').textContent = '$0';
    document.getElementById('overallROI').textContent = '0.00';
    return;
  }

  // 计算总广告费
  const totalAdSpend = summary.reduce((sum, merchant) => {
    console.log(`商家 ${merchant.merchant_name} 的广告费:`, merchant.total_cost);
    const cost = parseFloat(merchant.total_cost) || 0;
    console.log(`解析后的广告费:`, cost);
    return sum + cost;
  }, 0);
  
  console.log('计算出的总广告费:', totalAdSpend);
  console.log('保留2位小数:', totalAdSpend.toFixed(2));

  // 计算总佣金
  const totalCommission = summary.reduce((sum, merchant) => {
    return sum + (merchant.total_commission || 0);
  }, 0);

  // 计算整体ROI
  let overallROI = 0;
  let roiColor = '#999';
  if (totalAdSpend > 0) {
    overallROI = ((totalCommission - totalAdSpend) / totalAdSpend);
    roiColor = overallROI >= 0 ? '#28a745' : '#dc3545';
  }

  // 更新统计卡片
  document.getElementById('totalAdSpend').textContent = `$${totalAdSpend.toFixed(2)}`;
  document.getElementById('overallROI').textContent = `${overallROI.toFixed(2)}`;
  
  // 设置ROI颜色
  const roiElement = document.getElementById('overallROI');
  roiElement.style.color = roiColor;
  roiElement.style.fontWeight = 'bold';

  // 显示统计卡片
  document.getElementById('statsSection').style.display = 'block';
}

// 显示消息
function showMessage(elementId, message, type) {
  const el = document.getElementById(elementId);
  el.textContent = message;
  el.className = `status-message ${type}`;
}

// ============ Google表格管理 ============

// 加载Google表格列表
async function loadGoogleSheets() {
  try {
    const response = await fetch(`${API_BASE}/google-sheets`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });

    const result = await response.json();

    if (result.success) {
      googleSheets = result.data;
      renderGoogleSheetsList();
    }
  } catch (error) {
    console.error('加载Google表格失败:', error);
  }
}

// 渲染Google表格列表
function renderGoogleSheetsList() {
  const container = document.getElementById('googleSheetsList');

  if (googleSheets.length === 0) {
    container.innerHTML = '<p style="color: #999;">暂无Google表格，请先添加</p>';
    return;
  }

  container.innerHTML = googleSheets
    .map(
      sheet => `
    <div class="account-item">
      <div class="account-info">
        <div>
          <span class="platform-badge" style="background: #4285f4;">Google Sheets</span>
          <strong>${sheet.sheet_name}</strong>
          ${sheet.description ? `<div style="font-size: 12px; color: #999; margin-top: 5px;">${sheet.description}</div>` : ''}
          <div style="font-size: 12px; color: #999; margin-top: 5px;">
            添加于 ${new Date(sheet.created_at).toLocaleDateString()}
          </div>
        </div>
      </div>
      <div class="account-actions">
        <button onclick="collectGoogleSheetData(${sheet.id})" class="btn-primary" style="margin-right: 10px;">
          采集数据
        </button>
        <button onclick="viewSheetUrl('${sheet.sheet_url}')" class="btn-secondary" style="margin-right: 10px;">
          查看表格
        </button>
        <button onclick="deleteGoogleSheet(${sheet.id})" class="btn-danger">删除</button>
      </div>
    </div>
  `
    )
    .join('');
}

// 显示添加Google表格弹窗
function showAddGoogleSheetModal() {
  document.getElementById('addGoogleSheetModal').style.display = 'block';
}

// 关闭添加Google表格弹窗
function closeAddGoogleSheetModal() {
  document.getElementById('addGoogleSheetModal').style.display = 'none';
  document.getElementById('addGoogleSheetForm').reset();
  document.getElementById('addGoogleSheetStatus').className = 'status-message';
  document.getElementById('addGoogleSheetStatus').textContent = '';
}

// 处理添加Google表格
async function handleAddGoogleSheet(e) {
  e.preventDefault();

  const sheetName = document.getElementById('sheetName').value;
  const sheetUrl = document.getElementById('sheetUrl').value;
  const description = document.getElementById('sheetDescription').value;

  try {
    const response = await fetch(`${API_BASE}/google-sheets`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ sheetName, sheetUrl, description }),
    });

    const result = await response.json();

    if (result.success) {
      showMessage('addGoogleSheetStatus', '添加成功！', 'success');

      setTimeout(() => {
        closeAddGoogleSheetModal();
        loadGoogleSheets();
      }, 1000);
    } else {
      showMessage('addGoogleSheetStatus', result.message, 'error');
    }
  } catch (error) {
    showMessage('addGoogleSheetStatus', '网络请求失败: ' + error.message, 'error');
  }
}

// 删除Google表格
async function deleteGoogleSheet(sheetId) {
  if (!confirm('确定要删除这个Google表格吗？相关的广告数据也会被删除。')) return;

  try {
    const response = await fetch(`${API_BASE}/google-sheets/${sheetId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${authToken}` },
    });

    const result = await response.json();

    if (result.success) {
      alert('删除成功');
      loadGoogleSheets();
    } else {
      alert('删除失败: ' + result.message);
    }
  } catch (error) {
    alert('网络请求失败: ' + error.message);
  }
}

// 查看表格URL
function viewSheetUrl(url) {
  window.open(url, '_blank');
}

// 采集Google表格数据
async function collectGoogleSheetData(sheetId) {
  const sheet = googleSheets.find(s => s.id === sheetId);
  if (!sheet) return;

  if (!confirm(`确定要采集表格"${sheet.sheet_name}"的数据吗？`)) return;

  const statusMsg = `正在采集 ${sheet.sheet_name} 的数据...`;

  // 临时创建一个状态提示区域
  const statusDiv = document.createElement('div');
  statusDiv.id = 'collectSheetStatus';
  statusDiv.className = 'status-message info';
  statusDiv.textContent = statusMsg;
  statusDiv.style.marginTop = '15px';

  const container = document.getElementById('googleSheetsList');
  const existingStatus = document.getElementById('collectSheetStatus');
  if (existingStatus) {
    existingStatus.remove();
  }
  container.parentElement.insertBefore(statusDiv, container.nextSibling);

  try {
    const response = await fetch(`${API_BASE}/collect-google-sheets`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ sheetId }),
    });

    const result = await response.json();

    if (result.success) {
      statusDiv.textContent = `✅ ${result.message}`;
      statusDiv.className = 'status-message success';

      setTimeout(() => {
        statusDiv.remove();
      }, 5000);
    } else {
      statusDiv.textContent = `❌ 采集失败: ${result.message}`;
      statusDiv.className = 'status-message error';
    }
  } catch (error) {
    statusDiv.textContent = `❌ 网络请求失败: ${error.message}`;
    statusDiv.className = 'status-message error';
  }
}

// ============ 个人设置功能 ============

/**
 * 打开个人设置 Modal
 */
function openProfileSettings() {
  if (!currentUser) {
    alert('请先登录');
    return;
  }

  // 填充当前用户信息
  document.getElementById('profileEmail').value = currentUser.email;
  document.getElementById('profileUsername').value = currentUser.username;
  
  // 清空密码字段
  document.getElementById('profileCurrentPassword').value = '';
  document.getElementById('profileNewPassword').value = '';
  document.getElementById('profileConfirmPassword').value = '';
  
  // 清空状态消息
  document.getElementById('profileSettingsStatus').textContent = '';
  
  // 显示 Modal
  document.getElementById('profileSettingsModal').style.display = 'flex';
}

/**
 * 关闭个人设置 Modal
 */
function closeProfileSettings() {
  document.getElementById('profileSettingsModal').style.display = 'none';
}

/**
 * 处理个人设置表单提交
 */
document.addEventListener('DOMContentLoaded', () => {
  const profileForm = document.getElementById('profileSettingsForm');
  if (profileForm) {
    profileForm.addEventListener('submit', handleProfileSettingsSubmit);
  }
});

async function handleProfileSettingsSubmit(e) {
  e.preventDefault();
  
  const statusDiv = document.getElementById('profileSettingsStatus');
  statusDiv.textContent = '正在保存...';
  statusDiv.className = 'status-message';
  
  const username = document.getElementById('profileUsername').value.trim();
  const currentPassword = document.getElementById('profileCurrentPassword').value;
  const newPassword = document.getElementById('profileNewPassword').value;
  const confirmPassword = document.getElementById('profileConfirmPassword').value;
  
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
    
    const response = await fetch(`${API_BASE}/user/profile`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`
      },
      body: JSON.stringify(requestData)
    });
    
    const result = await response.json();
    
    if (result.success) {
      statusDiv.textContent = '✅ ' + result.message;
      statusDiv.className = 'status-message success';
      
      // 更新当前用户信息
      currentUser.username = username;
      document.getElementById('currentUser').textContent = username;
      
      // 2秒后关闭 Modal
      setTimeout(() => {
        closeProfileSettings();
        
        // 如果修改了密码，提示用户重新登录
        if (newPassword) {
          alert('密码已修改，请重新登录');
          logout();
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
window.onclick = function(event) {
  const modal = document.getElementById('profileSettingsModal');
  if (event.target === modal) {
    closeProfileSettings();
  }
}

// ============ 导出功能 ============

/**
 * 导出商家汇总为Excel
 */
async function exportMerchantSummary() {
  try {
    const exportBtn = document.getElementById('exportBtn');
    const originalText = exportBtn.innerHTML;
    
    // 禁用按钮并显示加载状态
    exportBtn.disabled = true;
    exportBtn.innerHTML = '<span>⏳</span> 生成中...';
    
    // 获取当前的筛选条件
    const startDate = document.getElementById('startDate').value;
    const endDate = document.getElementById('endDate').value;
    
    console.log('📊 开始导出商家汇总，日期范围:', startDate, '至', endDate);
    console.log('📊 选中的账号IDs:', selectedAccountIds);
    
    // 调用后端API
    const apiUrl = `${API_BASE}/export/merchant-summary`;
    console.log('📊 请求URL:', apiUrl);
    console.log('📊 请求参数:', { startDate, endDate, platformAccountIds: selectedAccountIds });
    
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        startDate,
        endDate,
        platformAccountIds: selectedAccountIds
      }),
    });
    
    console.log('📊 响应状态:', response.status, response.statusText);
    
    if (!response.ok) {
      // 尝试获取错误详情
      let errorMessage = `HTTP ${response.status}: ${response.statusText}`;
      try {
        const errorData = await response.text();
        console.error('📊 错误响应内容:', errorData);
        const errorJson = JSON.parse(errorData);
        if (errorJson.message) {
          errorMessage = errorJson.message;
        }
      } catch (e) {
        // 忽略解析错误
      }
      throw new Error(errorMessage);
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
    let filename = '商家汇总.xlsx';
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
    showMessage('collectStatus', '✅ Excel文件已成功导出！', 'success');
    console.log('✅ 导出成功:', filename);
    
  } catch (error) {
    console.error('导出Excel失败:', error);
    showMessage('collectStatus', `❌ 导出失败: ${error.message}`, 'error');
  } finally {
    // 恢复按钮状态
    const exportBtn = document.getElementById('exportBtn');
    exportBtn.disabled = false;
    exportBtn.innerHTML = '<span>📥</span> 导出Excel';
  }
}

// ============ 结算查询模块 ============

// 结算查询相关变量
let settlementCurrentPage = 1;
let settlementPageSize = 50;
let settlementFilters = {
  startDate: '',
  endDate: '',
  platformAccountId: '',
  status: 'all',
  orderAmountMin: '',
  orderAmountMax: '',
  commissionMin: '',
  commissionMax: '',
  merchantId: '',
  merchantName: '',
  orderId: ''
};
let settlementAllOrders = []; // 存储所有订单数据（用于前端筛选和排序，受状态筛选影响）
let settlementAllOrdersUnfiltered = []; // 存储所有订单数据（不受状态筛选影响，用于商家汇总）
let settlementCurrentSort = { column: null, direction: null }; // 当前排序状态
let settlementTableSearchText = ''; // 表格搜索文本
let settlementCurrentView = 'merchant'; // 当前视图：'merchant' 或 'detail'
let settlementMerchants = []; // 商家汇总数据
let settlementMerchantSort = { column: null, direction: null }; // 商家表格排序状态
let settlementMerchantSearchText = ''; // 商家搜索文本
let expandedMerchants = new Set(); // 已展开的商家ID集合
let settlementMerchantCurrentPage = 1; // 商家汇总当前页码
let settlementMerchantPageSize = 50; // 商家汇总每页显示数量

// 初始化结算查询模块
async function initSettlementModule() {
  try {
    // 格式化日期为本地时区的 YYYY-MM-DD 格式（避免时区问题）
    const formatLocalDate = (date) => {
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    };

    // 设置默认日期范围（最近30天）
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const endDate = new Date(today);
    endDate.setDate(today.getDate() - 1); // 昨天
    const startDate = new Date(endDate);
    startDate.setDate(endDate.getDate() - 29); // 30天前

    const startDateInput = document.getElementById('settlementStartDate');
    const endDateInput = document.getElementById('settlementEndDate');

    if (startDateInput && endDateInput) {
      startDateInput.valueAsDate = startDate;
      endDateInput.valueAsDate = endDate;
      // 使用本地时区格式化，避免 UTC 时区导致的日期偏差
      startDateInput.value = formatLocalDate(startDate);
      endDateInput.value = formatLocalDate(endDate);
    }

    // 加载平台账号列表
    await loadSettlementPlatformAccounts();

    // 不自动执行查询，等待用户点击"查询"或"采集数据"按钮
    // 只设置默认日期范围，不触发数据采集
  } catch (error) {
    console.error('初始化结算查询模块失败:', error);
  }
}

// 加载平台账号列表到下拉框
async function loadSettlementPlatformAccounts() {
  try {
    const response = await fetch(`${API_BASE}/platform-accounts`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });

    const result = await response.json();
    const select = document.getElementById('settlementPlatformAccount');

    if (!select) return;

    // 保留"全部"选项
    select.innerHTML = '<option value="">全部</option>';

    if (result.success && result.data && result.data.length > 0) {
      result.data.forEach(account => {
        const option = document.createElement('option');
        option.value = account.id;
        const displayName = account.affiliate_name 
          ? `${account.account_name} (${account.affiliate_name})`
          : account.account_name;
        option.textContent = `${account.platform} - ${displayName}`;
        select.appendChild(option);
      });
    }
  } catch (error) {
    console.error('加载平台账号列表失败:', error);
  }
}

// 快捷筛选设置
function setQuickFilter(filterType) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  // 最近7天：从7天前到昨天（不包含今天）
  const last7Days = new Date(yesterday);
  last7Days.setDate(last7Days.getDate() - 6);
  // 最近30天：从30天前到昨天（不包含今天）
  const last30Days = new Date(yesterday);
  last30Days.setDate(last30Days.getDate() - 29);
  // 最近3个月：从结束日期（昨天）往前推3个月（保持同一天）
  const last3Months = new Date(yesterday);
  last3Months.setMonth(last3Months.getMonth() - 3);
  // 最近6个月：从结束日期（昨天）往前推6个月（保持同一天）
  const last6Months = new Date(yesterday);
  last6Months.setMonth(last6Months.getMonth() - 6);
  // 最近12个月：从结束日期（昨天）往前推12个月（保持同一天）
  const last12Months = new Date(yesterday);
  last12Months.setMonth(last12Months.getMonth() - 12);

  // 月度计算
  const thisMonthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const lastMonthStart = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  const lastMonthEnd = new Date(today.getFullYear(), today.getMonth(), 0);
  const last2MonthsStart = new Date(today.getFullYear(), today.getMonth() - 2, 1);
  const last2MonthsEnd = new Date(today.getFullYear(), today.getMonth() - 1, 0);

  // 季度计算
  const currentQuarter = Math.floor(today.getMonth() / 3);
  const thisQuarterStart = new Date(today.getFullYear(), currentQuarter * 3, 1);
  const lastQuarterStart = new Date(today.getFullYear(), (currentQuarter - 1) * 3, 1);
  const lastQuarterEnd = new Date(today.getFullYear(), currentQuarter * 3, 0);
  const last2QuartersStart = new Date(today.getFullYear(), (currentQuarter - 2) * 3, 1);
  const last2QuartersEnd = new Date(today.getFullYear(), (currentQuarter - 1) * 3, 0);

  // 半年计算
  const isFirstHalf = today.getMonth() < 6;
  const firstHalfYearStart = new Date(today.getFullYear(), 0, 1);
  const firstHalfYearEnd = new Date(today.getFullYear(), 5, 30);
  const secondHalfYearStart = new Date(today.getFullYear(), 6, 1);
  const secondHalfYearEnd = new Date(today.getFullYear(), 11, 31);

  // 年度计算
  const thisYearStart = new Date(today.getFullYear(), 0, 1);
  const lastYearStart = new Date(today.getFullYear() - 1, 0, 1);
  const lastYearEnd = new Date(today.getFullYear() - 1, 11, 31);

  let startDate, endDate;

  switch (filterType) {
    case 'today':
      startDate = today;
      endDate = today;
      break;
    case 'yesterday':
      startDate = yesterday;
      endDate = yesterday;
      break;
    case 'last7days':
      startDate = last7Days;
      endDate = yesterday; // 结束日期为昨天（不包含今天）
      break;
    case 'last30days':
      startDate = last30Days;
      endDate = yesterday; // 结束日期为昨天（不包含今天）
      break;
    case 'thisMonth':
      startDate = thisMonthStart;
      endDate = yesterday; // 结束日期为昨天（不包含今天）
      break;
    case 'lastMonth':
      startDate = lastMonthStart;
      endDate = lastMonthEnd;
      break;
    case 'last2Months':
      startDate = last2MonthsStart;
      endDate = last2MonthsEnd;
      break;
    case 'thisQuarter':
      startDate = thisQuarterStart;
      endDate = yesterday; // 结束日期为昨天（不包含今天）
      break;
    case 'lastQuarter':
      startDate = lastQuarterStart;
      endDate = lastQuarterEnd;
      break;
    case 'last2Quarters':
      startDate = last2QuartersStart;
      endDate = last2QuartersEnd;
      break;
    case 'last3Months':
      startDate = last3Months;
      endDate = yesterday; // 结束日期为昨天（不包含今天）
      break;
    case 'last6Months':
      startDate = last6Months;
      endDate = yesterday; // 结束日期为昨天（不包含今天）
      break;
    case 'firstHalfYear':
      startDate = firstHalfYearStart;
      endDate = isFirstHalf ? yesterday : firstHalfYearEnd; // 如果是上半年，结束日期为昨天（不包含今天）
      break;
    case 'secondHalfYear':
      startDate = secondHalfYearStart;
      endDate = isFirstHalf ? secondHalfYearEnd : yesterday; // 如果是下半年，结束日期为昨天（不包含今天）
      break;
    case 'thisYear':
      startDate = thisYearStart;
      endDate = yesterday; // 结束日期为昨天（不包含今天）
      break;
    case 'lastYear':
      startDate = lastYearStart;
      endDate = lastYearEnd;
      break;
    case 'last12Months':
      startDate = last12Months;
      endDate = yesterday; // 结束日期为昨天（不包含今天）
      break;
    case 'custom':
      // 自定义模式，不设置日期，让用户手动选择
      return;
    default:
      return;
  }

  // 格式化日期为本地时区的 YYYY-MM-DD 格式（避免时区问题）
  const formatLocalDate = (date) => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };

  // 更新日期输入框
  const startDateInput = document.getElementById('settlementStartDate');
  const endDateInput = document.getElementById('settlementEndDate');
  if (startDateInput) {
    startDateInput.valueAsDate = startDate;
    // 使用本地时区格式化，避免 UTC 时区导致的日期偏差
    const startDateStr = formatLocalDate(startDate);
    startDateInput.value = startDateStr;
  }
  if (endDateInput) {
    endDateInput.valueAsDate = endDate;
    // 使用本地时区格式化，避免 UTC 时区导致的日期偏差
    const endDateStr = formatLocalDate(endDate);
    endDateInput.value = endDateStr;
  }
  
  console.log(`📅 快捷筛选 "${filterType}": ${formatLocalDate(startDate)} 至 ${formatLocalDate(endDate)}`);

  // 更新快捷筛选按钮状态
  document.querySelectorAll('.btn-quick-filter').forEach(btn => {
    btn.classList.remove('active');
    if (btn.getAttribute('data-filter') === filterType) {
      btn.classList.add('active');
    }
  });

  // 只设置日期，不自动查询（用户需要手动点击"查询"按钮）
  // handleSettlementFilter(); // 移除自动查询
}

// 处理订单状态改变
async function handleSettlementStatusChange() {
  const statusSelect = document.getElementById('settlementStatus');
  if (!statusSelect) return;
  
  const status = statusSelect.value;
  
  // 更新筛选条件
  settlementFilters.status = status;
  
  // 清除之前的排序，让自动排序生效
  settlementMerchantSort.column = null;
  settlementMerchantSort.direction = null;
  
  // 如果有日期范围，重新加载数据（不自动采集，只筛选已有数据）
  const startDate = document.getElementById('settlementStartDate')?.value;
  const endDate = document.getElementById('settlementEndDate')?.value;
  
  if (startDate && endDate) {
    // 状态筛选是在后端API中进行的，需要重新从服务器加载数据
    // 这样可以确保数据准确，并且统计数据也会正确更新
    // 同时会加载所有状态的订单用于商家汇总
    await loadSettlementData(false); // false表示不自动采集数据，只重新加载
  } else {
    // 如果没有日期范围，但商家汇总数据已存在，直接重新计算
    if (settlementAllOrdersUnfiltered.length > 0) {
      calculateMerchantSummary();
      renderSettlementMerchants();
    }
  }
}

// 切换高级筛选显示
function toggleAdvancedFilters() {
  const advancedFilters = document.getElementById('advancedFilters');
  const toggleBtn = document.getElementById('toggleAdvancedBtn');
  const toggleText = document.getElementById('toggleAdvancedText');

  if (advancedFilters && toggleBtn && toggleText) {
    const isVisible = advancedFilters.style.display !== 'none';
    advancedFilters.style.display = isVisible ? 'none' : 'block';
    toggleText.textContent = isVisible ? '展开高级筛选' : '收起高级筛选';
  }
}

// 重置筛选条件
function resetSettlementFilters() {
  // 重置日期（最近30天）
  const today = new Date();
  const endDate = new Date(today);
  endDate.setDate(today.getDate() - 1);
  const startDate = new Date(endDate);
  startDate.setDate(endDate.getDate() - 29);

  document.getElementById('settlementStartDate').valueAsDate = startDate;
  document.getElementById('settlementEndDate').valueAsDate = endDate;
  document.getElementById('settlementPlatformAccount').value = '';
  const statusSelect = document.getElementById('settlementStatus');
  if (statusSelect && statusSelect.tagName === 'SELECT') {
    statusSelect.value = 'all';
  }
  document.getElementById('settlementOrderAmountMin').value = '';
  document.getElementById('settlementOrderAmountMax').value = '';
  document.getElementById('settlementCommissionMin').value = '';
  document.getElementById('settlementCommissionMax').value = '';
  document.getElementById('settlementMerchantId').value = '';
  document.getElementById('settlementMerchantName').value = '';
  document.getElementById('settlementOrderId').value = '';
  document.getElementById('settlementTableSearch').value = '';

  // 重置快捷筛选按钮
  document.querySelectorAll('.btn-quick-filter').forEach(btn => {
    btn.classList.remove('active');
    if (btn.getAttribute('data-filter') === 'last30days') {
      btn.classList.add('active');
    }
  });

  // 重置排序
  settlementCurrentSort = { column: null, direction: null };
  settlementTableSearchText = '';
  settlementCurrentPage = 1;

  // 重新查询
  handleSettlementFilter();
}

// 处理结算查询筛选
async function handleSettlementFilter(event) {
  if (event) {
    event.preventDefault();
  }

  // 重置到第一页
  settlementCurrentPage = 1;

  // 获取基础筛选条件
  const startDateInput = document.getElementById('settlementStartDate');
  const endDateInput = document.getElementById('settlementEndDate');
  const platformAccountSelect = document.getElementById('settlementPlatformAccount');
  const statusSelect = document.getElementById('settlementStatus');

  const startDate = startDateInput ? startDateInput.value : '';
  const endDate = endDateInput ? endDateInput.value : '';
  const platformAccountId = platformAccountSelect ? platformAccountSelect.value : '';
  const status = statusSelect ? statusSelect.value : 'all';

  settlementFilters.startDate = startDate;
  settlementFilters.endDate = endDate;
  settlementFilters.platformAccountId = platformAccountId;
  settlementFilters.status = status;

  // 获取高级筛选条件
  const orderAmountMin = document.getElementById('settlementOrderAmountMin');
  const orderAmountMax = document.getElementById('settlementOrderAmountMax');
  const commissionMin = document.getElementById('settlementCommissionMin');
  const commissionMax = document.getElementById('settlementCommissionMax');
  const merchantId = document.getElementById('settlementMerchantId');
  const merchantName = document.getElementById('settlementMerchantName');
  const orderId = document.getElementById('settlementOrderId');

  settlementFilters.orderAmountMin = orderAmountMin ? orderAmountMin.value : '';
  settlementFilters.orderAmountMax = orderAmountMax ? orderAmountMax.value : '';
  settlementFilters.commissionMin = commissionMin ? commissionMin.value : '';
  settlementFilters.commissionMax = commissionMax ? commissionMax.value : '';
  settlementFilters.merchantId = merchantId ? merchantId.value.trim() : '';
  settlementFilters.merchantName = merchantName ? merchantName.value.trim() : '';
  settlementFilters.orderId = orderId ? orderId.value.trim() : '';

  // 检查日期范围是否有效
  if (!startDate || !endDate) {
    const statusEl = document.getElementById('settlementStatusMessage');
    if (statusEl) {
      statusEl.innerHTML = '<div style="display: flex; align-items: center; gap: 8px;"><span>❌</span><span>请先选择日期范围</span></div>';
      statusEl.className = 'status-message error';
      statusEl.style.display = 'block';
    }
    return;
  }

  // 查询时先自动采集数据（确保获取最新状态）
  // 这样查询按钮可以同时完成数据采集和查询
  await collectSettlementDataForQuery(startDate, endDate, platformAccountId);

  // 采集完成后再加载数据
  await loadSettlementData(true);
}

/**
 * 为查询自动采集数据（不显示按钮状态，静默采集）
 */
async function collectSettlementDataForQuery(startDate, endDate, platformAccountId) {
  try {
    const statusEl = document.getElementById('settlementStatusMessage');
    if (statusEl) {
      statusEl.innerHTML = '<div style="display: flex; align-items: center; gap: 8px;"><span class="spinner" style="display: inline-block; width: 16px; height: 16px; border: 2px solid var(--accent); border-top-color: transparent; border-radius: 50%; animation: spin 0.8s linear infinite;"></span><span>🔄 正在自动采集最新数据以更新订单状态...</span></div>';
      statusEl.className = 'status-message info';
      statusEl.style.display = 'block';
    }

    // 获取所有平台账号（如果未选择特定账号）
    let accountIds = [];
    if (platformAccountId) {
      accountIds = [parseInt(platformAccountId)];
    } else {
      const response = await fetch(`${API_BASE}/platform-accounts`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      const result = await response.json();
      if (result.success && result.data) {
        accountIds = result.data.map(acc => acc.id);
      }
    }

    if (accountIds.length === 0) {
      console.warn('没有可用的平台账号，跳过数据采集');
      return;
    }

    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < accountIds.length; i++) {
      const accountId = accountIds[i];
      try {
        // 更新状态显示当前采集进度
        if (statusEl) {
          statusEl.innerHTML = `<div style="display: flex; align-items: center; gap: 8px;"><span class="spinner" style="display: inline-block; width: 16px; height: 16px; border: 2px solid var(--accent); border-top-color: transparent; border-radius: 50%; animation: spin 0.8s linear infinite;"></span><span>🔄 正在采集账号 ${i + 1}/${accountIds.length} 的最新数据...</span></div>`;
          statusEl.className = 'status-message info';
          statusEl.style.display = 'block';
        }

        const response = await fetch(`${API_BASE}/collect-orders`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${authToken}`,
          },
          body: JSON.stringify({
            platformAccountId: accountId,
            startDate,
            endDate,
          }),
        });

        const result = await response.json();
        if (result.success) {
          successCount++;
          // 记录采集结果（但不显示，避免干扰）
          if (result.message) {
            console.log(`账号 ${accountId} 采集结果: ${result.message}`);
          }
        } else {
          failCount++;
          console.warn(`账号 ${accountId} 采集失败: ${result.message}`);
        }
      } catch (error) {
        failCount++;
        console.warn(`采集账号 ${accountId} 失败:`, error);
      }

      // 延迟1秒（后端已经有自己的请求间隔控制，这里只是账号之间的延迟）
      if (i < accountIds.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    // 显示采集完成信息（简短）
    if (statusEl) {
      if (successCount > 0) {
        statusEl.innerHTML = `<div style="display: flex; align-items: center; gap: 8px;"><span>✅</span><span>数据已更新（${successCount}个账号成功${failCount > 0 ? `，${failCount}个失败` : ''}）</span></div>`;
        statusEl.className = 'status-message success';
        statusEl.style.display = 'block';
        // 3秒后清除状态信息
        setTimeout(() => {
          if (statusEl.innerHTML.includes('数据已更新')) {
            statusEl.innerHTML = '';
            statusEl.className = '';
            statusEl.style.display = 'none';
          }
        }, 3000);
      } else {
        statusEl.innerHTML = `<div style="display: flex; align-items: center; gap: 8px;"><span>⚠️</span><span>数据采集失败，将显示已有数据</span></div>`;
        statusEl.className = 'status-message error';
        statusEl.style.display = 'block';
        setTimeout(() => {
          if (statusEl.innerHTML.includes('数据采集失败')) {
            statusEl.innerHTML = '';
            statusEl.className = '';
            statusEl.style.display = 'none';
          }
        }, 4000);
      }
    }
  } catch (error) {
    console.error('自动采集数据失败:', error);
    const statusEl = document.getElementById('settlementStatusMessage');
    if (statusEl) {
      statusEl.innerHTML = `<div style="display: flex; align-items: center; gap: 8px;"><span>⚠️</span><span>自动采集失败，将显示已有数据: ${error.message}</span></div>`;
      statusEl.className = 'status-message error';
      statusEl.style.display = 'block';
      setTimeout(() => {
        if (statusEl.innerHTML.includes('自动采集失败')) {
          statusEl.innerHTML = '';
          statusEl.className = '';
          statusEl.style.display = 'none';
        }
      }, 4000);
    }
  }
}

// 加载结算数据
async function loadSettlementData(applyFilters = false) {
  try {
    const statusEl = document.getElementById('settlementStatusMessage');
    if (statusEl && !statusEl.innerHTML.includes('数据已更新') && !statusEl.innerHTML.includes('采集')) {
      statusEl.innerHTML = '<div style="display: flex; align-items: center; gap: 8px;"><span class="spinner" style="display: inline-block; width: 16px; height: 16px; border: 2px solid var(--accent); border-top-color: transparent; border-radius: 50%; animation: spin 0.8s linear infinite;"></span><span>📊 正在加载数据...</span></div>';
      statusEl.className = 'status-message info';
      statusEl.style.display = 'block';
    }

    // 构建查询参数（获取所有数据，用于前端筛选）
    const params = new URLSearchParams();
    if (settlementFilters.startDate) {
      params.append('startDate', settlementFilters.startDate);
    }
    if (settlementFilters.endDate) {
      params.append('endDate', settlementFilters.endDate);
    }
    if (settlementFilters.platformAccountId) {
      params.append('platformAccountId', settlementFilters.platformAccountId);
    }
    if (settlementFilters.status && settlementFilters.status !== 'all') {
      params.append('status', settlementFilters.status);
    }
    // 获取所有数据用于前端筛选（必须同时传page和pageSize才能正确分页）
    params.append('page', '1');
    params.append('pageSize', '1000');

    // 获取统计数据
    const statsParams = new URLSearchParams();
    if (settlementFilters.startDate) {
      statsParams.append('startDate', settlementFilters.startDate);
    }
    if (settlementFilters.endDate) {
      statsParams.append('endDate', settlementFilters.endDate);
    }
    if (settlementFilters.platformAccountId) {
      statsParams.append('platformAccountId', settlementFilters.platformAccountId);
    }
    if (settlementFilters.status && settlementFilters.status !== 'all') {
      statsParams.append('status', settlementFilters.status);
    }

    const [ordersResponse, statsResponse] = await Promise.all([
      fetch(`${API_BASE}/orders?${params.toString()}`, {
        headers: { Authorization: `Bearer ${authToken}` },
      }),
      fetch(`${API_BASE}/stats?${statsParams.toString()}`, {
        headers: { Authorization: `Bearer ${authToken}` },
      })
    ]);

    const ordersResult = await ordersResponse.json();
    const statsResult = await statsResponse.json();

    if (!ordersResult.success || !statsResult.success) {
      throw new Error(ordersResult.message || statsResult.message || '获取数据失败');
    }

    // 存储筛选后的订单数据（第一页）
    settlementAllOrders = ordersResult.data || [];
    
    // 如果返回的数据有分页信息，且当前页不是最后一页，需要循环获取所有数据
    if (ordersResult.pagination && ordersResult.pagination.totalPages > 1) {
      const totalPages = ordersResult.pagination.totalPages;
      let allFilteredOrders = [...settlementAllOrders];
      
      // 从第2页开始获取（第1页已经获取了）
      for (let page = 2; page <= totalPages && page <= 100; page++) { // 最多100页，防止无限循环
        const pageParams = new URLSearchParams();
        if (settlementFilters.startDate) {
          pageParams.append('startDate', settlementFilters.startDate);
        }
        if (settlementFilters.endDate) {
          pageParams.append('endDate', settlementFilters.endDate);
        }
        if (settlementFilters.platformAccountId) {
          pageParams.append('platformAccountId', settlementFilters.platformAccountId);
        }
        if (settlementFilters.status && settlementFilters.status !== 'all') {
          pageParams.append('status', settlementFilters.status);
        }
        pageParams.append('page', page.toString());
        pageParams.append('pageSize', '1000');
        
        try {
          const pageResponse = await fetch(`${API_BASE}/orders?${pageParams.toString()}`, {
            headers: { Authorization: `Bearer ${authToken}` },
          });
          const pageResult = await pageResponse.json();
          
          if (pageResult.success && pageResult.data) {
            allFilteredOrders = allFilteredOrders.concat(pageResult.data);
            console.log(`📄 加载筛选后订单: 第 ${page}/${totalPages} 页，已获取 ${allFilteredOrders.length} 条`);
          }
        } catch (error) {
          console.warn(`⚠️ 加载第 ${page} 页订单失败:`, error);
        }
      }
      
      settlementAllOrders = allFilteredOrders;
      console.log(`✅ 已加载所有筛选后的订单数据: ${settlementAllOrders.length} 条`);
    }
    
    // 如果状态筛选不是"全部"，需要加载所有状态的订单用于商家汇总
    if (settlementFilters.status && settlementFilters.status !== 'all') {
      // 加载所有状态的订单（用于商家汇总计算）
      // 需要循环获取所有页面的数据，确保数据完整
      const allStatusParams = new URLSearchParams();
      if (settlementFilters.startDate) {
        allStatusParams.append('startDate', settlementFilters.startDate);
      }
      if (settlementFilters.endDate) {
        allStatusParams.append('endDate', settlementFilters.endDate);
      }
      if (settlementFilters.platformAccountId) {
        allStatusParams.append('platformAccountId', settlementFilters.platformAccountId);
      }
      // 不传status参数，获取所有状态的订单
      allStatusParams.append('pageSize', '1000'); // 使用合理的页面大小
      
      try {
        let allOrders = [];
        let currentPage = 1;
        let hasMore = true;
        let totalPages = 1;
        
        // 循环获取所有页面的数据
        while (hasMore && currentPage <= 100) { // 最多100页，防止无限循环
          const pageParams = new URLSearchParams(allStatusParams);
          pageParams.append('page', currentPage.toString());
          
          const allStatusResponse = await fetch(`${API_BASE}/orders?${pageParams.toString()}`, {
            headers: { Authorization: `Bearer ${authToken}` },
          });
          const allStatusResult = await allStatusResponse.json();
          
          if (allStatusResult.success) {
            const pageOrders = allStatusResult.data || [];
            allOrders = allOrders.concat(pageOrders);
            
            // 检查是否还有更多数据
            if (allStatusResult.pagination) {
              totalPages = allStatusResult.pagination.totalPages || 1;
              hasMore = currentPage < totalPages;
            } else {
              // 如果没有分页信息，根据返回的数据量判断
              hasMore = pageOrders.length >= 1000; // 如果返回的数据量等于pageSize，可能还有更多
            }
            
            console.log(`📄 加载所有状态订单: 第 ${currentPage}/${totalPages} 页，已获取 ${allOrders.length} 条`);
            
            currentPage++;
          } else {
            console.warn('⚠️ 加载所有状态订单失败:', allStatusResult.message);
            hasMore = false;
          }
        }
        
        settlementAllOrdersUnfiltered = allOrders;
        console.log(`✅ 已加载所有状态的订单数据: ${settlementAllOrdersUnfiltered.length} 条（用于商家汇总）`);
      } catch (error) {
        console.error('加载所有状态订单失败:', error);
        settlementAllOrdersUnfiltered = settlementAllOrders; // 如果失败，使用筛选后的数据
      }
    } else {
      // 如果状态是"全部"，则两个数据源相同
      settlementAllOrdersUnfiltered = settlementAllOrders;
    }

    console.log(`📊 数据加载完成: 筛选后订单 ${settlementAllOrders.length} 条，所有状态订单 ${settlementAllOrdersUnfiltered.length} 条`);
    
    // 检查数据完整性
    if (settlementAllOrdersUnfiltered.length === 0) {
      console.warn('⚠️ 警告: settlementAllOrdersUnfiltered 为空，商家汇总将无法正确计算');
    } else {
      // 检查订单中merchant_id的分布
      const merchantIdStats = {};
      settlementAllOrdersUnfiltered.forEach(order => {
        const merchantId = order.merchant_id || 'null';
        merchantIdStats[merchantId] = (merchantIdStats[merchantId] || 0) + 1;
      });
      const uniqueMerchants = Object.keys(merchantIdStats).length;
      const nullMerchantOrders = merchantIdStats['null'] || 0;
      console.log(`📊 订单数据统计: 共 ${uniqueMerchants} 个不同的merchant_id（包括null）`);
      if (nullMerchantOrders > 0) {
        console.warn(`   ⚠️ 发现 ${nullMerchantOrders} 条订单的merchant_id为null`);
      }
    }

    // 检测数据完整性
    checkSettlementDataCompleteness();

    // 计算商家汇总（使用所有状态的订单数据）
    calculateMerchantSummary();
    
    // 重置商家汇总分页到第一页
    settlementMerchantCurrentPage = 1;
    
    console.log(`📊 商家汇总计算完成: ${settlementMerchants.length} 个商家`);

    // 应用前端筛选
    if (applyFilters) {
      applyFrontendFilters();
    } else {
      // 直接渲染
      if (settlementCurrentView === 'merchant') {
        renderSettlementMerchants();
      } else {
        renderFilteredSettlementTable();
      }
    }

    // 渲染统计数据
    renderSettlementStats(statsResult.data);

    // 显示统计、视图切换和表格
    const statsSection = document.getElementById('settlementStats');
    const viewToggle = document.getElementById('settlementViewToggle');
    const merchantSection = document.getElementById('settlementMerchantSection');
    const tableSection = document.getElementById('settlementTableSection');
    
    if (statsSection) statsSection.style.display = 'block';
    if (viewToggle) viewToggle.style.display = 'flex';
    
    if (settlementCurrentView === 'merchant') {
      if (merchantSection) merchantSection.style.display = 'block';
      if (tableSection) tableSection.style.display = 'none';
    } else {
      if (merchantSection) merchantSection.style.display = 'none';
      if (tableSection) tableSection.style.display = 'block';
    }

    // 数据加载完成，显示成功信息
    if (statusEl) {
      const totalOrders = settlementAllOrders.length;
      const filteredCount = applyFilters ? (settlementCurrentView === 'merchant' ? settlementMerchants.length : settlementFilteredOrdersCache.length) : totalOrders;
      
      if (totalOrders > 0) {
        statusEl.innerHTML = `<div style="display: flex; align-items: center; gap: 8px;"><span>✅</span><span>数据加载完成！共 ${totalOrders} 条订单${applyFilters && filteredCount !== totalOrders ? `，筛选后 ${filteredCount} 条` : ''}</span></div>`;
        statusEl.className = 'status-message success';
        statusEl.style.display = 'block';
        // 3秒后自动清除
        setTimeout(() => {
          if (statusEl.innerHTML.includes('数据加载完成')) {
            statusEl.innerHTML = '';
            statusEl.className = '';
            statusEl.style.display = 'none';
          }
        }, 3000);
      } else {
        statusEl.innerHTML = `<div style="display: flex; align-items: center; gap: 8px;"><span>ℹ️</span><span>未找到符合条件的订单数据</span></div>`;
        statusEl.className = 'status-message info';
        statusEl.style.display = 'block';
      }
    }

  } catch (error) {
    console.error('加载结算数据失败:', error);
    const statusEl = document.getElementById('settlementStatusMessage');
    if (statusEl) {
      statusEl.innerHTML = `<div style="display: flex; align-items: center; gap: 8px;"><span>❌</span><span>加载失败: ${error.message}</span></div>`;
      statusEl.className = 'status-message error';
      statusEl.style.display = 'block';
    }
  }
}

// 渲染统计数据
function renderSettlementStats(stats) {
  if (!stats) return;

  const totalOrdersEl = document.getElementById('settlementTotalOrders');
  const totalCommissionEl = document.getElementById('settlementTotalCommission');
  const confirmedCommissionEl = document.getElementById('settlementConfirmedCommission');
  const pendingCommissionEl = document.getElementById('settlementPendingCommission');
  const rejectedCommissionEl = document.getElementById('settlementRejectedCommission');

  if (totalOrdersEl) {
    totalOrdersEl.textContent = stats.total_orders || 0;
  }
  if (totalCommissionEl) {
    totalCommissionEl.textContent = '$' + (parseFloat(stats.total_commission || 0).toFixed(2));
  }
  if (confirmedCommissionEl) {
    confirmedCommissionEl.textContent = '$' + (parseFloat(stats.confirmed_commission || 0).toFixed(2));
  }
  if (pendingCommissionEl) {
    pendingCommissionEl.textContent = '$' + (parseFloat(stats.pending_commission || 0).toFixed(2));
  }
  if (rejectedCommissionEl) {
    rejectedCommissionEl.textContent = '$' + (parseFloat(stats.rejected_commission || 0).toFixed(2));
  }
}

// 应用前端筛选
function applyFrontendFilters() {
  let filteredOrders = [...settlementAllOrders];

  // 基础筛选：订单状态
  if (settlementFilters.status && settlementFilters.status !== 'all') {
    const statusFilter = settlementFilters.status;
    filteredOrders = filteredOrders.filter(order => {
      const orderStatus = order.status || 'Pending';
      // 状态映射：Approved -> 已确认, Rejected -> 已拒绝, Pending -> 待确认
      if (statusFilter === '已确认') {
        return orderStatus === 'Approved';
      } else if (statusFilter === '已拒绝') {
        return orderStatus === 'Rejected';
      } else if (statusFilter === '待确认') {
        return orderStatus === 'Pending' || orderStatus === '待确认';
      }
      return true;
    });
  }

  // 高级筛选：金额范围
  if (settlementFilters.orderAmountMin) {
    const min = parseFloat(settlementFilters.orderAmountMin);
    filteredOrders = filteredOrders.filter(order => parseFloat(order.order_amount || 0) >= min);
  }
  if (settlementFilters.orderAmountMax) {
    const max = parseFloat(settlementFilters.orderAmountMax);
    filteredOrders = filteredOrders.filter(order => parseFloat(order.order_amount || 0) <= max);
  }
  if (settlementFilters.commissionMin) {
    const min = parseFloat(settlementFilters.commissionMin);
    filteredOrders = filteredOrders.filter(order => parseFloat(order.commission || 0) >= min);
  }
  if (settlementFilters.commissionMax) {
    const max = parseFloat(settlementFilters.commissionMax);
    filteredOrders = filteredOrders.filter(order => parseFloat(order.commission || 0) <= max);
  }

  // 高级筛选：商家ID
  if (settlementFilters.merchantId) {
    const merchantIdLower = settlementFilters.merchantId.toLowerCase();
    filteredOrders = filteredOrders.filter(order => 
      (order.merchant_id || '').toLowerCase().includes(merchantIdLower)
    );
  }

  // 高级筛选：商家名称
  if (settlementFilters.merchantName) {
    const merchantNameLower = settlementFilters.merchantName.toLowerCase();
    filteredOrders = filteredOrders.filter(order => 
      (order.merchant_name || '').toLowerCase().includes(merchantNameLower)
    );
  }

  // 高级筛选：订单ID
  if (settlementFilters.orderId) {
    const orderIdLower = settlementFilters.orderId.toLowerCase();
    filteredOrders = filteredOrders.filter(order => 
      (order.order_id || '').toLowerCase().includes(orderIdLower)
    );
  }

  // 表格搜索
  if (settlementTableSearchText) {
    const searchLower = settlementTableSearchText.toLowerCase();
    filteredOrders = filteredOrders.filter(order => {
      const orderId = (order.order_id || '').toLowerCase();
      const merchantName = (order.merchant_name || '').toLowerCase();
      const merchantId = (order.merchant_id || '').toLowerCase();
      return orderId.includes(searchLower) || merchantName.includes(searchLower) || merchantId.includes(searchLower);
    });
  }

  // 应用排序
  if (settlementCurrentSort.column) {
    filteredOrders.sort((a, b) => {
      let aVal, bVal;
      const column = settlementCurrentSort.column;

      switch (column) {
        case 'order_id':
          aVal = (a.order_id || '').toLowerCase();
          bVal = (b.order_id || '').toLowerCase();
          break;
        case 'order_date':
          aVal = new Date(a.order_date || 0).getTime();
          bVal = new Date(b.order_date || 0).getTime();
          break;
        case 'platform':
          aVal = (a.platform_name || a.platform_account_name || '').toLowerCase();
          bVal = (b.platform_name || b.platform_account_name || '').toLowerCase();
          break;
        case 'merchant_id':
          aVal = (a.merchant_id || '').toLowerCase();
          bVal = (b.merchant_id || '').toLowerCase();
          break;
        case 'merchant_name':
          aVal = (a.merchant_name || '').toLowerCase();
          bVal = (b.merchant_name || '').toLowerCase();
          break;
        case 'order_amount':
          aVal = parseFloat(a.order_amount || 0);
          bVal = parseFloat(b.order_amount || 0);
          break;
        case 'commission':
          aVal = parseFloat(a.commission || 0);
          bVal = parseFloat(b.commission || 0);
          break;
        case 'status':
          aVal = (a.status || 'Pending').toLowerCase();
          bVal = (b.status || 'Pending').toLowerCase();
          break;
        default:
          return 0;
      }

      if (aVal < bVal) return settlementCurrentSort.direction === 'asc' ? -1 : 1;
      if (aVal > bVal) return settlementCurrentSort.direction === 'asc' ? 1 : -1;
      return 0;
    });
  }

  // 保存所有筛选后的订单数据（用于详情查看）
  settlementAllFilteredOrdersCache = filteredOrders;

  // 商家汇总始终使用所有状态的订单数据，不受前端筛选影响
  // 不需要重新计算商家汇总，因为它已经基于所有订单数据计算了
  // calculateMerchantSummary(); // 不需要重新计算

  // 更新分页
  const totalPages = Math.ceil(filteredOrders.length / settlementPageSize);
  const startIndex = (settlementCurrentPage - 1) * settlementPageSize;
  const endIndex = startIndex + settlementPageSize;
  const paginatedOrders = filteredOrders.slice(startIndex, endIndex);

  // 保存当前显示的订单数据到缓存
  settlementFilteredOrdersCache = paginatedOrders;

  // 根据当前视图渲染表格
  if (settlementCurrentView === 'merchant') {
    renderSettlementMerchants();
  } else {
    renderFilteredSettlementTable(paginatedOrders, {
      total: filteredOrders.length,
      page: settlementCurrentPage,
      pageSize: settlementPageSize,
      totalPages: totalPages
    });
  }
}

// 渲染筛选后的订单表格
function renderFilteredSettlementTable(orders = null, pagination = null) {
  const tbody = document.getElementById('settlementTableBody');
  if (!tbody) return;

  // 如果没有传入数据，使用当前筛选后的数据
  if (!orders) {
    applyFrontendFilters();
    return;
  }

  if (!orders || orders.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align: center; padding: 40px; color: var(--text-secondary);">暂无数据</td></tr>';
    updateSettlementPagination(pagination);
    return;
  }

  tbody.innerHTML = orders.map((order, index) => {
    const orderDate = order.order_date ? new Date(order.order_date).toLocaleDateString('zh-CN') : '-';
    const status = order.status || 'Pending';
    let statusText = '待确认';
    let statusColor = '#f59e0b'; // 黄色

    if (status === 'Approved') {
      statusText = '已确认';
      statusColor = '#10b981'; // 绿色
    } else if (status === 'Rejected') {
      statusText = '已拒绝';
      statusColor = '#ef4444'; // 红色
    }

    const platformName = order.platform_name || order.platform_account_name || '-';
    const merchantName = order.merchant_name || '-';
    const orderAmount = parseFloat(order.order_amount || 0).toFixed(2);
    const commission = parseFloat(order.commission || 0).toFixed(2);

    return `
      <tr onclick="showSettlementOrderDetail(${index})" data-order-index="${index}">
        <td style="font-family: monospace; font-size: 12px;">${order.order_id || '-'}</td>
        <td>${orderDate}</td>
        <td>${platformName}</td>
        <td>${order.merchant_id || '-'}</td>
        <td>${merchantName}</td>
        <td>$${orderAmount}</td>
        <td><strong style="color: #a78bfa;">$${commission}</strong></td>
        <td><span style="color: ${statusColor}; font-weight: 600;">${statusText}</span></td>
      </tr>
    `;
  }).join('');

  // 更新分页信息
  updateSettlementPagination(pagination);
}

// 更新分页信息
function updateSettlementPagination(pagination) {
  if (!pagination) return;

  const paginationEl = document.getElementById('settlementPagination');
  const pageInfoEl = document.getElementById('settlementPageInfo');
  const prevBtn = document.getElementById('settlementPrevBtn');
  const nextBtn = document.getElementById('settlementNextBtn');

  if (paginationEl) {
    if (pagination.totalPages > 1) {
      paginationEl.style.display = 'flex';
      paginationEl.style.flexDirection = 'row';
    } else {
      paginationEl.style.display = 'none';
    }
  }

  if (pageInfoEl) {
    pageInfoEl.textContent = `第 ${pagination.page} 页，共 ${pagination.totalPages} 页（共 ${pagination.total} 条）`;
  }

  if (prevBtn) {
    prevBtn.disabled = pagination.page <= 1;
  }

  if (nextBtn) {
    nextBtn.disabled = pagination.page >= pagination.totalPages;
  }
}

// 切换分页
function changeSettlementPage(direction) {
  if (direction === 'prev' && settlementCurrentPage > 1) {
    settlementCurrentPage--;
  } else if (direction === 'next') {
    settlementCurrentPage++;
  }

  // 使用前端筛选重新渲染
  applyFrontendFilters();
}

// 表格排序
function sortSettlementTable(column) {
  // 如果点击同一列，切换排序方向；否则设置为升序
  if (settlementCurrentSort.column === column) {
    settlementCurrentSort.direction = settlementCurrentSort.direction === 'asc' ? 'desc' : 'asc';
  } else {
    settlementCurrentSort.column = column;
    settlementCurrentSort.direction = 'asc';
  }

  // 重置到第一页
  settlementCurrentPage = 1;

  // 更新排序指示器
  document.querySelectorAll('.sort-indicator').forEach(indicator => {
    indicator.classList.remove('asc', 'desc');
    if (indicator.getAttribute('data-column') === column) {
      indicator.classList.add(settlementCurrentSort.direction);
    }
  });

  // 应用排序并重新渲染
  applyFrontendFilters();
}

// 表格搜索
function filterSettlementTable() {
  const searchInput = document.getElementById('settlementTableSearch');
  if (searchInput) {
    settlementTableSearchText = searchInput.value.trim();
    settlementCurrentPage = 1; // 重置到第一页
    applyFrontendFilters();
  }
}

// 显示订单详情
let settlementFilteredOrdersCache = []; // 缓存当前显示的订单数据
let settlementAllFilteredOrdersCache = []; // 缓存所有筛选后的订单数据（用于详情查看）

function showSettlementOrderDetail(index) {
  // 获取当前页显示的订单数据
  if (settlementFilteredOrdersCache.length === 0) {
    // 如果没有缓存，重新计算
    applyFrontendFilters();
    return;
  }

  // 计算全局索引（当前页的订单在全部筛选后订单中的位置）
  const globalIndex = (settlementCurrentPage - 1) * settlementPageSize + index;
  const order = settlementAllFilteredOrdersCache[globalIndex];
  
  if (!order) return;

  const modal = document.getElementById('settlementOrderDetailModal');
  const content = document.getElementById('settlementOrderDetailContent');

  if (!modal || !content) return;

  const orderDate = order.order_date ? new Date(order.order_date).toLocaleDateString('zh-CN') : '-';
  const confirmDate = order.confirm_date ? new Date(order.confirm_date).toLocaleDateString('zh-CN') : '-';
  const status = order.status || 'Pending';
  let statusText = '待确认';
  let statusColor = '#f59e0b';

  if (status === 'Approved') {
    statusText = '已确认';
    statusColor = '#10b981';
  } else if (status === 'Rejected') {
    statusText = '已拒绝';
    statusColor = '#ef4444';
  }

  content.innerHTML = `
    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px;">
      <div>
        <div style="color: var(--text-secondary); font-size: 13px; margin-bottom: 4px;">订单ID</div>
        <div style="font-family: monospace; font-size: 14px; font-weight: 600;">${order.order_id || '-'}</div>
      </div>
      <div>
        <div style="color: var(--text-secondary); font-size: 13px; margin-bottom: 4px;">订单状态</div>
        <div style="color: ${statusColor}; font-weight: 600;">${statusText}</div>
      </div>
      <div>
        <div style="color: var(--text-secondary); font-size: 13px; margin-bottom: 4px;">订单日期</div>
        <div>${orderDate}</div>
      </div>
      <div>
        <div style="color: var(--text-secondary); font-size: 13px; margin-bottom: 4px;">确认日期</div>
        <div>${confirmDate || '-'}</div>
      </div>
      <div>
        <div style="color: var(--text-secondary); font-size: 13px; margin-bottom: 4px;">平台</div>
        <div>${order.platform_name || order.platform_account_name || '-'}</div>
      </div>
      <div>
        <div style="color: var(--text-secondary); font-size: 13px; margin-bottom: 4px;">联盟序号</div>
        <div>${order.affiliate_name || '-'}</div>
      </div>
      <div>
        <div style="color: var(--text-secondary); font-size: 13px; margin-bottom: 4px;">商家ID</div>
        <div>${order.merchant_id || '-'}</div>
      </div>
      <div>
        <div style="color: var(--text-secondary); font-size: 13px; margin-bottom: 4px;">商家名称</div>
        <div>${order.merchant_name || '-'}</div>
      </div>
      <div>
        <div style="color: var(--text-secondary); font-size: 13px; margin-bottom: 4px;">订单金额</div>
        <div style="font-size: 16px; font-weight: 600;">$${parseFloat(order.order_amount || 0).toFixed(2)}</div>
      </div>
      <div>
        <div style="color: var(--text-secondary); font-size: 13px; margin-bottom: 4px;">佣金金额</div>
        <div style="font-size: 16px; font-weight: 600; color: #a78bfa;">$${parseFloat(order.commission || 0).toFixed(2)}</div>
      </div>
    </div>
  `;

  modal.style.display = 'block';
}

// 关闭订单详情弹窗
function closeSettlementOrderDetail() {
  const modal = document.getElementById('settlementOrderDetailModal');
  if (modal) {
    modal.style.display = 'none';
  }
}

// 导出结算数据
async function exportSettlementData() {
  try {
    const exportBtn = document.getElementById('settlementExportBtn');
    if (exportBtn) {
      exportBtn.disabled = true;
      exportBtn.innerHTML = '<span>⏳</span> 导出中...';
    }

    // 获取当前筛选后的所有订单数据（应用所有前端筛选）
    let filteredOrders = [...settlementAllOrders];

    // 应用所有筛选条件
    if (settlementFilters.orderAmountMin) {
      const min = parseFloat(settlementFilters.orderAmountMin);
      filteredOrders = filteredOrders.filter(order => parseFloat(order.order_amount || 0) >= min);
    }
    if (settlementFilters.orderAmountMax) {
      const max = parseFloat(settlementFilters.orderAmountMax);
      filteredOrders = filteredOrders.filter(order => parseFloat(order.order_amount || 0) <= max);
    }
    if (settlementFilters.commissionMin) {
      const min = parseFloat(settlementFilters.commissionMin);
      filteredOrders = filteredOrders.filter(order => parseFloat(order.commission || 0) >= min);
    }
    if (settlementFilters.commissionMax) {
      const max = parseFloat(settlementFilters.commissionMax);
      filteredOrders = filteredOrders.filter(order => parseFloat(order.commission || 0) <= max);
    }
    if (settlementFilters.merchantId) {
      const merchantIdLower = settlementFilters.merchantId.toLowerCase();
      filteredOrders = filteredOrders.filter(order => 
        (order.merchant_id || '').toLowerCase().includes(merchantIdLower)
      );
    }
    if (settlementFilters.merchantName) {
      const merchantNameLower = settlementFilters.merchantName.toLowerCase();
      filteredOrders = filteredOrders.filter(order => 
        (order.merchant_name || '').toLowerCase().includes(merchantNameLower)
      );
    }
    if (settlementFilters.orderId) {
      const orderIdLower = settlementFilters.orderId.toLowerCase();
      filteredOrders = filteredOrders.filter(order => 
        (order.order_id || '').toLowerCase().includes(orderIdLower)
      );
    }
    if (settlementTableSearchText) {
      const searchLower = settlementTableSearchText.toLowerCase();
      filteredOrders = filteredOrders.filter(order => {
        const orderId = (order.order_id || '').toLowerCase();
        const merchantName = (order.merchant_name || '').toLowerCase();
        const merchantId = (order.merchant_id || '').toLowerCase();
        return orderId.includes(searchLower) || merchantName.includes(searchLower) || merchantId.includes(searchLower);
      });
    }

    // 获取统计数据
    const statsParams = new URLSearchParams();
    if (settlementFilters.startDate) {
      statsParams.append('startDate', settlementFilters.startDate);
    }
    if (settlementFilters.endDate) {
      statsParams.append('endDate', settlementFilters.endDate);
    }
    if (settlementFilters.platformAccountId) {
      statsParams.append('platformAccountId', settlementFilters.platformAccountId);
    }
    if (settlementFilters.status && settlementFilters.status !== 'all') {
      statsParams.append('status', settlementFilters.status);
    }

    const statsResponse = await fetch(`${API_BASE}/stats?${statsParams.toString()}`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    const statsResult = await statsResponse.json();
    const stats = statsResult.success ? statsResult.data : null;

    const orders = filteredOrders;

    // 检查ExcelJS是否可用
    const ExcelJS = window.ExcelJS;
    
    // 使用SheetJS（如果ExcelJS不可用）
    if (!ExcelJS) {
      // 使用简单的CSV导出
      const csvContent = [
        ['订单ID', '订单日期', '平台', '商家ID', '商家名称', '订单金额', '佣金金额', '订单状态'].join(','),
        ...orders.map(order => {
          const status = order.status || 'Pending';
          let statusText = '待确认';
          if (status === 'Approved') statusText = '已确认';
          else if (status === 'Rejected') statusText = '已拒绝';

          return [
            order.order_id || '',
            order.order_date ? new Date(order.order_date).toLocaleDateString('zh-CN') : '',
            order.platform_name || order.platform_account_name || '',
            order.merchant_id || '',
            order.merchant_name || '',
            order.order_amount || 0,
            order.commission || 0,
            statusText
          ].join(',');
        })
      ].join('\n');

      const blob = new Blob(['\ufeff' + csvContent], { type: 'text/csv;charset=utf-8;' });
      const link = document.createElement('a');
      const url = URL.createObjectURL(blob);
      link.setAttribute('href', url);
      link.setAttribute('download', `结算数据_${new Date().toISOString().split('T')[0]}.csv`);
      link.style.visibility = 'hidden';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      const statusEl = document.getElementById('settlementStatusMessage');
      if (statusEl) {
        statusEl.textContent = '✅ CSV文件已成功导出！';
        statusEl.className = 'status-message success';
      }

      if (exportBtn) {
        exportBtn.disabled = false;
        exportBtn.innerHTML = '<span>📥</span> 导出Excel';
      }
      return;
    }

    // 使用ExcelJS导出（如果可用）
    if (!ExcelJS) {
      throw new Error('ExcelJS未加载，将使用CSV格式导出');
    }

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('结算数据');

    // 添加统计汇总（如果有）
    if (stats) {
      worksheet.addRow(['结算数据统计汇总']);
      worksheet.addRow([]);
      worksheet.addRow(['总订单数', stats.total_orders || 0]);
      worksheet.addRow(['总佣金', `$${parseFloat(stats.total_commission || 0).toFixed(2)}`]);
      worksheet.addRow(['已确认佣金', `$${parseFloat(stats.confirmed_commission || 0).toFixed(2)}`]);
      worksheet.addRow(['待确认佣金', `$${parseFloat(stats.pending_commission || 0).toFixed(2)}`]);
      worksheet.addRow(['已拒绝佣金', `$${parseFloat(stats.rejected_commission || 0).toFixed(2)}`]);
      worksheet.addRow([]);
      worksheet.addRow(['筛选条件']);
      worksheet.addRow(['开始日期', settlementFilters.startDate || '全部']);
      worksheet.addRow(['结束日期', settlementFilters.endDate || '全部']);
      worksheet.addRow(['订单状态', settlementFilters.status === 'all' ? '全部' : settlementFilters.status]);
      worksheet.addRow([]);
      worksheet.addRow(['订单明细']);
      worksheet.addRow([]);
    }

    // 设置表头
    worksheet.columns = [
      { header: '订单ID', key: 'order_id', width: 20 },
      { header: '订单日期', key: 'order_date', width: 15 },
      { header: '平台', key: 'platform', width: 15 },
      { header: '商家ID', key: 'merchant_id', width: 15 },
      { header: '商家名称', key: 'merchant_name', width: 30 },
      { header: '订单金额', key: 'order_amount', width: 15 },
      { header: '佣金金额', key: 'commission', width: 15 },
      { header: '订单状态', key: 'status', width: 15 }
    ];

    // 设置表头样式
    const headerRow = worksheet.getRow(worksheet.rowCount + 1);
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF4285F4' }
    };
    headerRow.alignment = { vertical: 'middle', horizontal: 'center' };

    // 添加数据
    orders.forEach(order => {
      const status = order.status || 'Pending';
      let statusText = '待确认';
      if (status === 'Approved') statusText = '已确认';
      else if (status === 'Rejected') statusText = '已拒绝';

      worksheet.addRow({
        order_id: order.order_id || '',
        order_date: order.order_date ? new Date(order.order_date).toLocaleDateString('zh-CN') : '',
        platform: order.platform_name || order.platform_account_name || '',
        merchant_id: order.merchant_id || '',
        merchant_name: order.merchant_name || '',
        order_amount: parseFloat(order.order_amount || 0),
        commission: parseFloat(order.commission || 0),
        status: statusText
      });
    });

    // 设置数据行样式（金额列右对齐）
    const dataStartRow = stats ? (worksheet.rowCount - orders.length + 1) : 2;
    for (let i = dataStartRow; i <= worksheet.rowCount; i++) {
      const row = worksheet.getRow(i);
      row.getCell(6).numFmt = '$#,##0.00'; // 订单金额
      row.getCell(7).numFmt = '$#,##0.00'; // 佣金金额
      row.getCell(6).alignment = { horizontal: 'right' };
      row.getCell(7).alignment = { horizontal: 'right' };
    }

    // 导出文件
    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    const dateStr = new Date().toISOString().split('T')[0];
    link.setAttribute('href', url);
    link.setAttribute('download', `结算数据_${dateStr}.xlsx`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    const statusEl = document.getElementById('settlementStatusMessage');
    if (statusEl) {
      statusEl.textContent = `✅ Excel文件已成功导出！共 ${orders.length} 条订单`;
      statusEl.className = 'status-message success';
    }

  } catch (error) {
    console.error('导出结算数据失败:', error);
    const statusEl = document.getElementById('settlementStatusMessage');
    if (statusEl) {
      statusEl.textContent = `❌ 导出失败: ${error.message}`;
      statusEl.className = 'status-message error';
    }
  } finally {
    const exportBtn = document.getElementById('settlementExportBtn');
    if (exportBtn) {
      exportBtn.disabled = false;
      exportBtn.innerHTML = '<span>📥</span> 导出Excel';
    }
  }
}

// ============ 结算查询新功能函数 ============

// 检测数据完整性
function checkSettlementDataCompleteness() {
  const statusDiv = document.getElementById('settlementDataStatus');
  const statusIcon = document.getElementById('settlementDataStatusIcon');
  const statusText = document.getElementById('settlementDataStatusText');
  
  if (!statusDiv || !statusIcon || !statusText) return;

  if (settlementAllOrders.length === 0) {
    statusDiv.style.display = 'block';
    statusDiv.style.borderLeftColor = '#f59e0b';
    statusIcon.textContent = '⚠️';
    statusText.innerHTML = `该日期范围内暂无数据，请点击<strong style="color: var(--accent);">"采集数据"</strong>按钮获取数据`;
  } else {
    statusDiv.style.display = 'none';
  }
}

// 计算商家汇总
function calculateMerchantSummary() {
  const merchantMap = new Map();

  // 商家汇总使用所有状态的订单数据，不受状态筛选影响
  // 这样可以看到所有商家，即使某个商家在当前筛选状态下没有订单
  const ordersToProcess = [...settlementAllOrdersUnfiltered];
  
  // 获取当前状态筛选条件（用于统计对应状态的佣金）
  const currentStatusFilter = settlementFilters.status;

  // 按商家分组统计
  ordersToProcess.forEach(order => {
    const merchantId = order.merchant_id || 'unknown';
    const merchantName = order.merchant_name || '';
    
    if (!merchantMap.has(merchantId)) {
      merchantMap.set(merchantId, {
        merchant_id: merchantId,
        merchant_name: merchantName,
        platforms: new Set(), // 使用Set存储平台，避免重复
        orders: [],
        total_orders: 0,
        total_order_amount: 0,
        total_commission: 0,
        confirmed_commission: 0,
        pending_commission: 0,
        rejected_commission: 0,
        // 当前筛选状态下的统计数据
        filtered_orders: 0,
        filtered_order_amount: 0,
        filtered_commission: 0
      });
    }
    
    // 收集平台信息
    const platformName = order.platform_name || order.platform_account_name || '';
    if (platformName) {
      merchantMap.get(merchantId).platforms.add(platformName);
    }

    const merchant = merchantMap.get(merchantId);
    merchant.orders.push(order);
    
    // 总统计（所有状态的订单）
    merchant.total_orders++;
    merchant.total_order_amount += parseFloat(order.order_amount || 0);
    merchant.total_commission += parseFloat(order.commission || 0);

    // 按状态分类统计
    const status = order.status || 'Pending';
    if (status === 'Approved') {
      merchant.confirmed_commission += parseFloat(order.commission || 0);
    } else if (status === 'Rejected') {
      merchant.rejected_commission += parseFloat(order.commission || 0);
    } else {
      merchant.pending_commission += parseFloat(order.commission || 0);
    }
    
    // 如果当前有状态筛选，统计筛选状态下的数据
    if (currentStatusFilter && currentStatusFilter !== 'all') {
      let matchesFilter = false;
      if (currentStatusFilter === '已确认' && status === 'Approved') {
        matchesFilter = true;
      } else if (currentStatusFilter === '已拒绝' && status === 'Rejected') {
        matchesFilter = true;
      } else if (currentStatusFilter === '待确认' && (status === 'Pending' || status === '待确认')) {
        matchesFilter = true;
      }
      
      if (matchesFilter) {
        merchant.filtered_orders++;
        merchant.filtered_order_amount += parseFloat(order.order_amount || 0);
        merchant.filtered_commission += parseFloat(order.commission || 0);
      }
    }
  });

  // 将Set转换为数组，方便显示，并计算结算率和拒付率
  settlementMerchants = Array.from(merchantMap.values()).map(merchant => {
    // 计算结算率 = 已确认佣金 / 总佣金 * 100%
    const settlementRate = merchant.total_commission > 0 
      ? (merchant.confirmed_commission / merchant.total_commission * 100) 
      : 0;
    
    // 计算拒付率 = 已拒绝佣金 / 总佣金 * 100%
    const rejectionRate = merchant.total_commission > 0 
      ? (merchant.rejected_commission / merchant.total_commission * 100) 
      : 0;
    
    return {
      ...merchant,
      platforms: Array.from(merchant.platforms), // 将Set转换为数组
      platform_display: Array.from(merchant.platforms).join('、') || '-', // 用于显示的平台名称
      settlement_rate: settlementRate, // 结算率（百分比）
      rejection_rate: rejectionRate // 拒付率（百分比）
    };
  });
  
  // 调试信息
  console.log(`📊 商家汇总统计: 共 ${settlementMerchants.length} 个商家`);
  console.log(`   - 处理的订单总数: ${ordersToProcess.length} 条`);
  
  if (settlementMerchants.length > 0) {
    const totalOrders = settlementMerchants.reduce((sum, m) => sum + m.total_orders, 0);
    const totalCommission = settlementMerchants.reduce((sum, m) => sum + m.total_commission, 0);
    console.log(`   - 商家汇总订单数总和: ${totalOrders}, 总佣金: $${totalCommission.toFixed(2)}`);
    
    // 检查是否有merchant_id为'unknown'的订单
    const unknownMerchant = settlementMerchants.find(m => m.merchant_id === 'unknown');
    if (unknownMerchant) {
      console.warn(`   ⚠️ 发现 ${unknownMerchant.total_orders} 条订单的merchant_id为空，被归类为'unknown'`);
    }
    
    // 检查订单数是否一致
    if (totalOrders !== ordersToProcess.length) {
      console.error(`   ❌ 数据不一致！处理的订单数: ${ordersToProcess.length}, 商家汇总订单数总和: ${totalOrders}`);
      console.error(`   ❌ 差异: ${ordersToProcess.length - totalOrders} 条订单可能未被正确统计`);
    } else {
      console.log(`   ✅ 订单数统计一致: ${totalOrders} 条`);
    }
  }
}

// 视图切换
function switchSettlementView(view) {
  settlementCurrentView = view;

  const merchantBtn = document.getElementById('merchantViewBtn');
  const detailBtn = document.getElementById('detailViewBtn');
  const merchantSection = document.getElementById('settlementMerchantSection');
  const tableSection = document.getElementById('settlementTableSection');

  if (merchantBtn && detailBtn) {
    if (view === 'merchant') {
      merchantBtn.classList.add('active');
      detailBtn.classList.remove('active');
      if (merchantSection) merchantSection.style.display = 'block';
      if (tableSection) tableSection.style.display = 'none';
      renderSettlementMerchants();
    } else {
      merchantBtn.classList.remove('active');
      detailBtn.classList.add('active');
      if (merchantSection) merchantSection.style.display = 'none';
      if (tableSection) tableSection.style.display = 'block';
      renderFilteredSettlementTable();
    }
  }
}

// 渲染商家汇总表格
function renderSettlementMerchants() {
  // 确保使用最新的商家汇总数据
  if (!settlementMerchants || settlementMerchants.length === 0) {
    console.warn('⚠️ 商家汇总数据为空，重新计算...');
    calculateMerchantSummary();
  }
  
  let filteredMerchants = [...settlementMerchants];
  
  console.log(`📊 渲染商家汇总: 共 ${settlementMerchants.length} 个商家，搜索后 ${filteredMerchants.length} 个`);

  // 根据订单状态筛选商家
  const currentStatusFilter = settlementFilters.status;
  if (currentStatusFilter && currentStatusFilter !== 'all' && currentStatusFilter !== '待确认') {
    if (currentStatusFilter === '已确认') {
      // 只显示有已确认佣金的商家
      filteredMerchants = filteredMerchants.filter(merchant => {
        return (merchant.confirmed_commission || 0) > 0;
      });
    } else if (currentStatusFilter === '已拒绝') {
      // 只显示有已拒绝佣金的商家
      filteredMerchants = filteredMerchants.filter(merchant => {
        return (merchant.rejected_commission || 0) > 0;
      });
    }
  }

  // 应用商家搜索（包括商家ID、商家名称和平台名称）
  if (settlementMerchantSearchText) {
    const searchLower = settlementMerchantSearchText.toLowerCase();
    filteredMerchants = filteredMerchants.filter(merchant => {
      const merchantId = (merchant.merchant_id || '').toLowerCase();
      const merchantName = (merchant.merchant_name || '').toLowerCase();
      const platformDisplay = (merchant.platform_display || '').toLowerCase();
      return merchantId.includes(searchLower) || 
             merchantName.includes(searchLower) || 
             platformDisplay.includes(searchLower);
    });
  }

  // 根据订单状态自动设置排序（如果用户没有手动排序）
  if (!settlementMerchantSort.column) {
    if (currentStatusFilter === '全部' || currentStatusFilter === 'all' || currentStatusFilter === '已确认') {
      // 按照结算率从大到小排序
      settlementMerchantSort.column = 'settlement_rate';
      settlementMerchantSort.direction = 'desc';
    } else if (currentStatusFilter === '已拒绝') {
      // 按照拒付率排序（从大到小，显示拒付率高的商家）
      settlementMerchantSort.column = 'rejection_rate';
      settlementMerchantSort.direction = 'desc';
    }
  }

  // 更新排序指示器（包括自动排序）
  if (settlementMerchantSort.column) {
    document.querySelectorAll('#settlementMerchantTable .sort-indicator').forEach(indicator => {
      indicator.classList.remove('asc', 'desc');
      if (indicator.getAttribute('data-column') === settlementMerchantSort.column) {
        indicator.classList.add(settlementMerchantSort.direction);
      }
    });
  }

  // 应用排序
  if (settlementMerchantSort.column) {
    filteredMerchants.sort((a, b) => {
      let aVal, bVal;
      const column = settlementMerchantSort.column;

      switch (column) {
        case 'merchant_id':
          aVal = (a.merchant_id || '').toLowerCase();
          bVal = (b.merchant_id || '').toLowerCase();
          break;
        case 'merchant_name':
          aVal = (a.merchant_name || '').toLowerCase();
          bVal = (b.merchant_name || '').toLowerCase();
          break;
        case 'total_orders':
          aVal = a.total_orders || 0;
          bVal = b.total_orders || 0;
          break;
        case 'total_order_amount':
          aVal = a.total_order_amount || 0;
          bVal = b.total_order_amount || 0;
          break;
        case 'total_commission':
          aVal = a.total_commission || 0;
          bVal = b.total_commission || 0;
          break;
        case 'confirmed_commission':
          aVal = a.confirmed_commission || 0;
          bVal = b.confirmed_commission || 0;
          break;
        case 'pending_commission':
          aVal = a.pending_commission || 0;
          bVal = b.pending_commission || 0;
          break;
        case 'rejected_commission':
          aVal = a.rejected_commission || 0;
          bVal = b.rejected_commission || 0;
          break;
        case 'settlement_rate':
          aVal = a.settlement_rate || 0;
          bVal = b.settlement_rate || 0;
          break;
        case 'rejection_rate':
          aVal = a.rejection_rate || 0;
          bVal = b.rejection_rate || 0;
          break;
        case 'platform':
          aVal = (a.platform_display || '').toLowerCase();
          bVal = (b.platform_display || '').toLowerCase();
          break;
        default:
          return 0;
      }

      if (aVal < bVal) return settlementMerchantSort.direction === 'asc' ? -1 : 1;
      if (aVal > bVal) return settlementMerchantSort.direction === 'asc' ? 1 : -1;
      return 0;
    });
  }

  const tbody = document.getElementById('settlementMerchantTableBody');
  if (!tbody) return;

  if (filteredMerchants.length === 0) {
    tbody.innerHTML = '<tr><td colspan="12" style="text-align: center; padding: 40px; color: var(--text-secondary);">暂无数据</td></tr>';
    // 更新分页信息
    updateSettlementMerchantPagination({ total: 0, page: 1, pageSize: settlementMerchantPageSize, totalPages: 0 });
    return;
  }

  // 计算分页
  const totalPages = Math.ceil(filteredMerchants.length / settlementMerchantPageSize);
  const startIndex = (settlementMerchantCurrentPage - 1) * settlementMerchantPageSize;
  const endIndex = startIndex + settlementMerchantPageSize;
  const paginatedMerchants = filteredMerchants.slice(startIndex, endIndex);

  // 更新分页信息
  updateSettlementMerchantPagination({
    total: filteredMerchants.length,
    page: settlementMerchantCurrentPage,
    pageSize: settlementMerchantPageSize,
    totalPages: totalPages
  });

  tbody.innerHTML = paginatedMerchants.map(merchant => {
    const isExpanded = expandedMerchants.has(merchant.merchant_id);
    
    // 如果展开，需要根据当前状态筛选显示对应的订单
    let ordersToShow = [];
    if (isExpanded) {
      const currentStatusFilter = settlementFilters.status;
      if (currentStatusFilter && currentStatusFilter !== 'all') {
        // 只显示当前筛选状态下的订单
        ordersToShow = merchant.orders.filter(order => {
          const status = order.status || 'Pending';
          if (currentStatusFilter === '已确认') {
            return status === 'Approved';
          } else if (currentStatusFilter === '已拒绝') {
            return status === 'Rejected';
          } else if (currentStatusFilter === '待确认') {
            return status === 'Pending' || status === '待确认';
          }
          return true;
        });
      } else {
        // 显示所有订单
        ordersToShow = merchant.orders;
      }
    }
    const merchantOrdersHtml = isExpanded ? renderMerchantOrders(ordersToShow) : '';

    // 格式化结算率和拒付率，让数据更明显
    const settlementRate = merchant.settlement_rate || 0;
    const rejectionRate = merchant.rejection_rate || 0;
    const settlementRateText = settlementRate.toFixed(1) + '%';
    const rejectionRateText = rejectionRate.toFixed(1) + '%';
    
    // 结算率颜色和背景：越高越好，绿色系
    let settlementRateColor = '#10b981'; // 绿色
    let settlementRateBg = 'rgba(16, 185, 129, 0.15)'; // 浅绿色背景
    if (settlementRate < 50) {
      settlementRateColor = '#ef4444'; // 红色（低）
      settlementRateBg = 'rgba(239, 68, 68, 0.15)'; // 浅红色背景
    } else if (settlementRate < 70) {
      settlementRateColor = '#f59e0b'; // 橙色（中）
      settlementRateBg = 'rgba(245, 158, 11, 0.15)'; // 浅橙色背景
    }
    
    // 拒付率颜色和背景：越低越好，红色系
    let rejectionRateColor = '#ef4444'; // 红色
    let rejectionRateBg = 'rgba(239, 68, 68, 0.15)'; // 浅红色背景
    if (rejectionRate < 10) {
      rejectionRateColor = '#10b981'; // 绿色（低）
      rejectionRateBg = 'rgba(16, 185, 129, 0.15)'; // 浅绿色背景
    } else if (rejectionRate < 20) {
      rejectionRateColor = '#f59e0b'; // 橙色（中）
      rejectionRateBg = 'rgba(245, 158, 11, 0.15)'; // 浅橙色背景
    }

    return `
      <tr>
        <td style="text-align: center; font-family: monospace; font-size: 12px;">${merchant.merchant_id || '-'}</td>
        <td style="text-align: center;">${merchant.merchant_name || '-'}</td>
        <td style="text-align: center; font-size: 12px; color: var(--text-secondary);">${merchant.platform_display || '-'}</td>
        <td style="text-align: center;">${merchant.total_orders}</td>
        <td style="text-align: right;">$${merchant.total_order_amount.toFixed(2)}</td>
        <td style="text-align: right; font-weight: 600; color: #a78bfa;">$${merchant.total_commission.toFixed(2)}</td>
        <td style="text-align: right; color: #10b981;">$${merchant.confirmed_commission.toFixed(2)}</td>
        <td style="text-align: right; color: #f59e0b;">$${merchant.pending_commission.toFixed(2)}</td>
        <td style="text-align: right; color: #ef4444;">$${merchant.rejected_commission.toFixed(2)}</td>
        <td style="text-align: center; font-weight: 700; font-size: 15px; color: ${settlementRateColor}; background-color: ${settlementRateBg}; padding: 8px 12px; border-radius: 6px;">
          ${settlementRateText}
        </td>
        <td style="text-align: center; font-weight: 700; font-size: 15px; color: ${rejectionRateColor}; background-color: ${rejectionRateBg}; padding: 8px 12px; border-radius: 6px;">
          ${rejectionRateText}
        </td>
        <td style="text-align: center;">
          <button onclick="toggleMerchantDetail('${merchant.merchant_id}')" class="btn-secondary" style="padding: 4px 8px; font-size: 12px;">
            ${isExpanded ? '收起' : '展开'}
          </button>
        </td>
      </tr>
      ${isExpanded ? `<tr class="merchant-detail-row"><td colspan="12">${merchantOrdersHtml}</td></tr>` : ''}
    `;
  }).join('');
}

// 渲染商家订单明细
function renderMerchantOrders(orders) {
  if (!orders || orders.length === 0) return '<div style="padding: 12px;">暂无订单</div>';

  const ordersHtml = orders.map(order => {
    const orderDate = order.order_date ? new Date(order.order_date).toLocaleDateString('zh-CN') : '-';
    const status = order.status || 'Pending';
    let statusText = '待确认';
    let statusColor = '#f59e0b';

    if (status === 'Approved') {
      statusText = '已确认';
      statusColor = '#10b981';
    } else if (status === 'Rejected') {
      statusText = '已拒绝';
      statusColor = '#ef4444';
    }

    return `
      <tr>
        <td>${order.order_id || '-'}</td>
        <td>${orderDate}</td>
        <td>${order.platform_name || order.platform_account_name || '-'}</td>
        <td style="text-align: right;">$${parseFloat(order.order_amount || 0).toFixed(2)}</td>
        <td style="text-align: right;">$${parseFloat(order.commission || 0).toFixed(2)}</td>
        <td style="color: ${statusColor};">${statusText}</td>
      </tr>
    `;
  }).join('');

  return `
    <div style="padding: 12px;">
      <div style="font-weight: 600; margin-bottom: 8px;">订单明细 (${orders.length}条)</div>
      <table class="merchant-orders-table">
        <thead>
          <tr>
            <th>订单ID</th>
            <th>订单日期</th>
            <th>平台</th>
            <th>订单金额</th>
            <th>佣金金额</th>
            <th>状态</th>
          </tr>
        </thead>
        <tbody>
          ${ordersHtml}
        </tbody>
      </table>
    </div>
  `;
}

// 切换商家详情展开/收起
function toggleMerchantDetail(merchantId) {
  if (expandedMerchants.has(merchantId)) {
    expandedMerchants.delete(merchantId);
  } else {
    expandedMerchants.add(merchantId);
  }
  renderSettlementMerchants();
}

// 商家表格排序
function sortSettlementMerchants(column) {
  if (settlementMerchantSort.column === column) {
    settlementMerchantSort.direction = settlementMerchantSort.direction === 'asc' ? 'desc' : 'asc';
  } else {
    settlementMerchantSort.column = column;
    settlementMerchantSort.direction = 'asc';
  }

  document.querySelectorAll('#settlementMerchantTable .sort-indicator').forEach(indicator => {
    indicator.classList.remove('asc', 'desc');
    if (indicator.getAttribute('data-column') === column) {
      indicator.classList.add(settlementMerchantSort.direction);
    }
  });

  renderSettlementMerchants();
}

// 商家搜索
function filterSettlementMerchants() {
  const searchInput = document.getElementById('settlementMerchantSearch');
  if (searchInput) {
    settlementMerchantSearchText = searchInput.value.trim();
    settlementMerchantCurrentPage = 1; // 重置到第一页
    renderSettlementMerchants();
  }
}

// 更新商家汇总分页信息
function updateSettlementMerchantPagination(pagination) {
  const prevBtn = document.getElementById('settlementMerchantPrevBtn');
  const nextBtn = document.getElementById('settlementMerchantNextBtn');
  const pageInfo = document.getElementById('settlementMerchantPageInfo');

  if (!prevBtn || !nextBtn || !pageInfo) return;

  const { total, page, totalPages } = pagination;

  // 更新按钮状态
  prevBtn.disabled = page <= 1;
  nextBtn.disabled = page >= totalPages;

  // 更新页码信息
  if (totalPages > 0) {
    pageInfo.textContent = `第 ${page} / ${totalPages} 页，共 ${total} 个商家`;
  } else {
    pageInfo.textContent = '暂无数据';
  }
}

// 切换商家汇总页码
function changeSettlementMerchantPage(direction) {
  // 重新计算过滤后的商家数量（考虑搜索条件）
  let filteredMerchants = [...settlementMerchants];
  
  if (settlementMerchantSearchText) {
    const searchLower = settlementMerchantSearchText.toLowerCase();
    filteredMerchants = filteredMerchants.filter(merchant => {
      const merchantId = (merchant.merchant_id || '').toLowerCase();
      const merchantName = (merchant.merchant_name || '').toLowerCase();
      const platformDisplay = (merchant.platform_display || '').toLowerCase();
      return merchantId.includes(searchLower) || 
             merchantName.includes(searchLower) || 
             platformDisplay.includes(searchLower);
    });
  }
  
  const totalPages = Math.ceil(filteredMerchants.length / settlementMerchantPageSize);
  
  if (direction === 'prev' && settlementMerchantCurrentPage > 1) {
    settlementMerchantCurrentPage--;
  } else if (direction === 'next' && settlementMerchantCurrentPage < totalPages) {
    settlementMerchantCurrentPage++;
  }
  
  renderSettlementMerchants();
  // 滚动到表格顶部
  const tableContainer = document.querySelector('#settlementMerchantSection .table-container');
  if (tableContainer) {
    tableContainer.scrollTop = 0;
  }
}

// 采集结算数据
async function collectSettlementData() {
  try {
    const collectBtn = document.getElementById('collectSettlementBtn');
    if (collectBtn) {
      collectBtn.disabled = true;
      collectBtn.innerHTML = '<span>⏳</span> 采集中...';
    }

    const startDate = document.getElementById('settlementStartDate').value;
    const endDate = document.getElementById('settlementEndDate').value;
    const platformAccountId = document.getElementById('settlementPlatformAccount').value;

    if (!startDate || !endDate) {
      const statusEl = document.getElementById('settlementStatusMessage');
      if (statusEl) {
        statusEl.innerHTML = '<div style="display: flex; align-items: center; gap: 8px;"><span>❌</span><span>请先选择日期范围</span></div>';
        statusEl.className = 'status-message error';
        statusEl.style.display = 'block';
      }
      if (collectBtn) {
        collectBtn.disabled = false;
        collectBtn.innerHTML = '<span>📥</span> 采集数据';
      }
      return;
    }

    const statusEl = document.getElementById('settlementStatusMessage');
    if (statusEl) {
      statusEl.innerHTML = '<div style="display: flex; align-items: center; gap: 8px;"><span class="spinner" style="display: inline-block; width: 16px; height: 16px; border: 2px solid var(--accent); border-top-color: transparent; border-radius: 50%; animation: spin 0.8s linear infinite;"></span><span>📥 开始采集数据...</span></div>';
      statusEl.className = 'status-message info';
      statusEl.style.display = 'block';
    }

    // 获取所有平台账号（如果未选择特定账号）
    let accountIds = [];
    let accountMap = new Map(); // 存储账号ID到账号信息的映射
    
    if (platformAccountId) {
      accountIds = [parseInt(platformAccountId)];
      // 获取单个账号信息
      const response = await fetch(`${API_BASE}/platform-accounts`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      const result = await response.json();
      if (result.success && result.data) {
        const account = result.data.find(acc => acc.id === parseInt(platformAccountId));
        if (account) {
          accountMap.set(account.id, account);
        }
      }
    } else {
      const response = await fetch(`${API_BASE}/platform-accounts`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      const result = await response.json();
      if (result.success && result.data) {
        accountIds = result.data.map(acc => acc.id);
        result.data.forEach(acc => {
          accountMap.set(acc.id, acc);
        });
      }
    }

    if (accountIds.length === 0) {
      throw new Error('没有可用的平台账号');
    }

    // 显示开始采集的提示
    if (statusEl) {
      const accountNames = accountIds.map(id => {
        const acc = accountMap.get(id);
        return acc ? `${acc.platform_name}(${acc.account_name || acc.affiliate_name || 'N/A'})` : `账号${id}`;
      }).join('、');
      
      statusEl.innerHTML = `
        <div style="display: flex; flex-direction: column; gap: 8px;">
          <div style="display: flex; align-items: center; gap: 8px;">
            <span class="spinner" style="display: inline-block; width: 16px; height: 16px; border: 2px solid var(--accent); border-top-color: transparent; border-radius: 50%; animation: spin 0.8s linear infinite;"></span>
            <span style="font-weight: 500;">📥 开始采集数据...</span>
          </div>
          <div style="font-size: 12px; color: var(--text-secondary); padding-left: 24px;">
            日期范围: ${startDate} 至 ${endDate}<br>
            平台账号: ${accountNames} (共${accountIds.length}个)
          </div>
        </div>
      `;
      statusEl.className = 'status-message info';
      statusEl.style.display = 'block';
    }

    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < accountIds.length; i++) {
      const accountId = accountIds[i];
      const account = accountMap.get(accountId);
      const accountName = account ? `${account.platform_name}(${account.account_name || account.affiliate_name || 'N/A'})` : `账号${accountId}`;
      
      try {
        // 更新状态显示当前采集进度
        if (statusEl) {
          const progress = Math.round(((i + 1) / accountIds.length) * 100);
          statusEl.innerHTML = `
            <div style="display: flex; flex-direction: column; gap: 8px;">
              <div style="display: flex; align-items: center; gap: 8px;">
                <span class="spinner" style="display: inline-block; width: 16px; height: 16px; border: 2px solid var(--accent); border-top-color: transparent; border-radius: 50%; animation: spin 0.8s linear infinite;"></span>
                <span style="font-weight: 500;">正在采集账号 ${i + 1}/${accountIds.length}: ${accountName}</span>
              </div>
              <div style="display: flex; align-items: center; gap: 8px; padding-left: 24px;">
                <div style="flex: 1; height: 6px; background: var(--bg-tertiary); border-radius: 3px; overflow: hidden;">
                  <div style="height: 100%; background: var(--accent); width: ${progress}%; transition: width 0.3s ease;"></div>
                </div>
                <span style="font-size: 12px; color: var(--text-secondary); min-width: 40px; text-align: right;">${progress}%</span>
              </div>
              <div style="font-size: 12px; color: var(--text-secondary); padding-left: 24px;">
                系统会自动处理日期范围限制和分页，请耐心等待...
              </div>
            </div>
          `;
          statusEl.className = 'status-message info';
          statusEl.style.display = 'block';
        }

        const response = await fetch(`${API_BASE}/collect-orders`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${authToken}`,
          },
          body: JSON.stringify({
            platformAccountId: accountId,
            startDate,
            endDate,
          }),
        });

        const result = await response.json();
        if (result.success) {
          successCount++;
          // 显示详细的采集结果（可能包含日期分割信息）
          if (result.message) {
            console.log(`账号 ${accountName} 采集结果: ${result.message}`);
            // 更新状态显示采集成功
            if (statusEl && i < accountIds.length - 1) {
              const progress = Math.round(((i + 1) / accountIds.length) * 100);
              statusEl.innerHTML = `
                <div style="display: flex; flex-direction: column; gap: 8px;">
                  <div style="display: flex; align-items: center; gap: 8px;">
                    <span>✅</span>
                    <span style="font-weight: 500;">${accountName} 采集完成</span>
                  </div>
                  <div style="display: flex; align-items: center; gap: 8px; padding-left: 24px;">
                    <div style="flex: 1; height: 6px; background: var(--bg-tertiary); border-radius: 3px; overflow: hidden;">
                      <div style="height: 100%; background: var(--success); width: ${progress}%; transition: width 0.3s ease;"></div>
                    </div>
                    <span style="font-size: 12px; color: var(--text-secondary); min-width: 40px; text-align: right;">${progress}%</span>
                  </div>
                </div>
              `;
              // 短暂显示成功状态后继续
              await new Promise(resolve => setTimeout(resolve, 500));
            }
          }
        } else {
          failCount++;
          console.error(`账号 ${accountName} 采集失败:`, result.message);
          // 更新状态显示采集失败
          if (statusEl) {
            const progress = Math.round(((i + 1) / accountIds.length) * 100);
            statusEl.innerHTML = `
              <div style="display: flex; flex-direction: column; gap: 8px;">
                <div style="display: flex; align-items: center; gap: 8px;">
                  <span>⚠️</span>
                  <span style="font-weight: 500;">${accountName} 采集失败: ${result.message || '未知错误'}</span>
                </div>
                <div style="display: flex; align-items: center; gap: 8px; padding-left: 24px;">
                  <div style="flex: 1; height: 6px; background: var(--bg-tertiary); border-radius: 3px; overflow: hidden;">
                    <div style="height: 100%; background: var(--warning); width: ${progress}%; transition: width 0.3s ease;"></div>
                  </div>
                  <span style="font-size: 12px; color: var(--text-secondary); min-width: 40px; text-align: right;">${progress}%</span>
                </div>
              </div>
            `;
            // 短暂显示失败状态后继续
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
        }
      } catch (error) {
        failCount++;
        console.error(`采集账号 ${accountName} 失败:`, error);
        // 更新状态显示采集失败
        if (statusEl) {
          const progress = Math.round(((i + 1) / accountIds.length) * 100);
          statusEl.innerHTML = `
            <div style="display: flex; flex-direction: column; gap: 8px;">
              <div style="display: flex; align-items: center; gap: 8px;">
                <span>❌</span>
                <span style="font-weight: 500;">${accountName} 采集失败: ${error.message || '网络错误'}</span>
              </div>
              <div style="display: flex; align-items: center; gap: 8px; padding-left: 24px;">
                <div style="flex: 1; height: 6px; background: var(--bg-tertiary); border-radius: 3px; overflow: hidden;">
                  <div style="height: 100%; background: var(--danger); width: ${progress}%; transition: width 0.3s ease;"></div>
                </div>
                <span style="font-size: 12px; color: var(--text-secondary); min-width: 40px; text-align: right;">${progress}%</span>
              </div>
            </div>
          `;
          // 短暂显示失败状态后继续
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }

      // 延迟1秒（后端已经有自己的请求间隔控制，这里只是账号之间的延迟）
      if (i < accountIds.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    // 显示最终结果
    if (statusEl) {
      if (successCount > 0) {
        statusEl.innerHTML = `
          <div style="display: flex; flex-direction: column; gap: 8px;">
            <div style="display: flex; align-items: center; gap: 8px;">
              <span>✅</span>
              <span style="font-weight: 500;">数据采集完成！</span>
            </div>
            <div style="display: flex; align-items: center; gap: 8px; padding-left: 24px;">
              <div style="flex: 1; height: 6px; background: var(--bg-tertiary); border-radius: 3px; overflow: hidden;">
                <div style="height: 100%; background: var(--success); width: 100%; transition: width 0.3s ease;"></div>
              </div>
              <span style="font-size: 12px; color: var(--text-secondary); min-width: 40px; text-align: right;">100%</span>
            </div>
            <div style="font-size: 12px; color: var(--text-secondary); padding-left: 24px;">
              成功: ${successCount}个账号${failCount > 0 ? `，失败: ${failCount}个` : ''} | 正在加载数据...
            </div>
          </div>
        `;
        statusEl.className = 'status-message success';
        statusEl.style.display = 'block';
      } else {
        statusEl.innerHTML = `
          <div style="display: flex; flex-direction: column; gap: 8px;">
            <div style="display: flex; align-items: center; gap: 8px;">
              <span>❌</span>
              <span style="font-weight: 500;">数据采集失败</span>
            </div>
            <div style="font-size: 12px; color: var(--text-secondary); padding-left: 24px;">
              所有账号采集失败，请检查网络连接或稍后重试
            </div>
          </div>
        `;
        statusEl.className = 'status-message error';
        statusEl.style.display = 'block';
      }
    }

    // 重新加载数据
    if (successCount > 0) {
      await loadSettlementData(true);
    }

  } catch (error) {
    console.error('采集结算数据失败:', error);
    const statusEl = document.getElementById('settlementStatusMessage');
    if (statusEl) {
      statusEl.innerHTML = `<div style="display: flex; align-items: center; gap: 8px;"><span>❌</span><span>采集失败: ${error.message}</span></div>`;
      statusEl.className = 'status-message error';
      statusEl.style.display = 'block';
    }
  } finally {
    const collectBtn = document.getElementById('collectSettlementBtn');
    if (collectBtn) {
      collectBtn.disabled = false;
      collectBtn.innerHTML = '<span>📥</span> 采集数据';
    }
  }
}

// 导出商家汇总
async function exportSettlementMerchants() {
  // 使用现有导出功能，但导出商家汇总数据
  // 这里可以复用exportSettlementData的逻辑，但需要调整
  alert('商家汇总导出功能开发中...');
}

// ============ 推荐榜单功能 ============

// 显示主内容（数据采集）
function showMainContent() {
  const mainContentSection = document.getElementById('mainContentSection');
  const rankingContentSection = document.getElementById('rankingContentSection');
  const navItems = document.querySelectorAll('.nav-item');
  
  if (mainContentSection) mainContentSection.style.display = 'block';
  if (rankingContentSection) rankingContentSection.style.display = 'none';
  
  // 更新导航状态
  navItems.forEach(item => {
    item.classList.remove('active');
  });
  if (navItems[0]) navItems[0].classList.add('active');
}

// 显示推荐榜单
function showRankingSidebar() {
  const mainContentSection = document.getElementById('mainContentSection');
  const rankingContentSection = document.getElementById('rankingContentSection');
  const navItems = document.querySelectorAll('.nav-item');
  
  if (mainContentSection) mainContentSection.style.display = 'none';
  if (rankingContentSection) rankingContentSection.style.display = 'block';
  
  // 更新导航状态
  navItems.forEach(item => {
    item.classList.remove('active');
  });
  if (navItems[1]) navItems[1].classList.add('active');
  
  // 加载推荐榜单数据
  loadTopAdsRanking();
}

// 处理时间范围选择变化
function handleRankingRangeChange() {
  const rankingRange = document.getElementById('rankingRange');
  const customDateRange = document.getElementById('customDateRange');
  
  if (rankingRange.value === 'custom') {
    if (customDateRange) {
      customDateRange.style.display = 'flex';
      customDateRange.style.flexDirection = 'row';
      // 设置默认日期（最近7天，不包含今天）
      const today = new Date();
      const yesterday = new Date(today);
      yesterday.setDate(today.getDate() - 1);
      const sevenDaysAgo = new Date(yesterday);
      sevenDaysAgo.setDate(yesterday.getDate() - 6);
      
      const startDateInput = document.getElementById('rankingStartDate');
      const endDateInput = document.getElementById('rankingEndDate');
      if (startDateInput && !startDateInput.value) {
        startDateInput.valueAsDate = sevenDaysAgo;
      }
      if (endDateInput && !endDateInput.value) {
        endDateInput.valueAsDate = yesterday;
      }
    }
  } else {
    if (customDateRange) customDateRange.style.display = 'none';
    // 自动加载数据
    loadTopAdsRanking();
  }
}

// 加载推荐榜单
async function loadTopAdsRanking() {
  const rankingContentSection = document.getElementById('rankingContentSection');
  const rankingList = document.getElementById('rankingList');
  const rankingDateRange = document.getElementById('rankingDateRange');
  const rankingRange = document.getElementById('rankingRange');
  const customDateRange = document.getElementById('customDateRange');
  
  if (!rankingList) return;
  
  // 如果推荐榜单页面未显示，不加载数据
  if (rankingContentSection && rankingContentSection.style.display === 'none') {
    return;
  }
  
  // 显示自定义日期选择器
  if (rankingRange && rankingRange.value === 'custom') {
    if (customDateRange) {
      customDateRange.style.display = 'flex';
      customDateRange.style.flexDirection = 'row';
      // 设置默认日期（最近7天，不包含今天）
      const today = new Date();
      const yesterday = new Date(today);
      yesterday.setDate(today.getDate() - 1);
      const sevenDaysAgo = new Date(yesterday);
      sevenDaysAgo.setDate(yesterday.getDate() - 6);
      
      const startDateInput = document.getElementById('rankingStartDate');
      const endDateInput = document.getElementById('rankingEndDate');
      if (startDateInput && !startDateInput.value) {
        startDateInput.valueAsDate = sevenDaysAgo;
      }
      if (endDateInput && !endDateInput.value) {
        endDateInput.valueAsDate = yesterday;
      }
    }
  } else {
    if (customDateRange) customDateRange.style.display = 'none';
  }
  
  // 显示加载状态
  rankingList.innerHTML = '<div style="text-align: center; padding: 20px; color: rgba(255,255,255,0.8);">加载中...</div>';
  
  try {
    // 构建查询参数
    const params = new URLSearchParams({
      range: rankingRange ? rankingRange.value : 'yesterday'
    });
    
    if (rankingRange && rankingRange.value === 'custom') {
      const startDate = document.getElementById('rankingStartDate').value;
      const endDate = document.getElementById('rankingEndDate').value;
      if (startDate && endDate) {
        params.append('startDate', startDate);
        params.append('endDate', endDate);
      }
    }
    
    const response = await fetch(`${API_BASE}/top-ads-ranking?${params.toString()}`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    
    const result = await response.json();
    
    if (result.success && result.data) {
      displayTopAdsRanking(result.data, result.meta);
      // 同时显示稳定广告数据
      displayStableAdsRanking(result.stable_data || [], result.meta);
    } else {
      rankingList.innerHTML = `<div style="text-align: center; padding: 20px; color: rgba(255,255,255,0.8);">${result.message || '加载失败'}</div>`;
      displayStableAdsRanking([], null, '加载失败');
    }
  } catch (error) {
    console.error('加载推荐榜单错误:', error);
    rankingList.innerHTML = '<div style="text-align: center; padding: 20px; color: rgba(255,255,255,0.8);">加载失败，请重试</div>';
    displayStableAdsRanking([], null, '加载失败，请重试');
  }
}

// 显示推荐榜单
function displayTopAdsRanking(data, meta) {
  const rankingList = document.getElementById('rankingList');
  const rankingDateRange = document.getElementById('rankingDateRange');
  
  if (!rankingList) return;
  
  // 显示时间范围
  if (meta && meta.date_range) {
    rankingDateRange.textContent = `时间范围: ${meta.date_range.start} 至 ${meta.date_range.end}`;
  }
  
  if (!data || data.length === 0) {
    rankingList.innerHTML = '<div style="text-align: center; padding: 20px; color: rgba(255,255,255,0.8);">暂无推荐数据（ROI > 3的广告系列）</div>';
    return;
  }
  
  // 联盟平台名称映射
  const platformNames = {
    'linkhaitao': 'LinkHaitao',
    'partnermatic': 'PartnerMatic',
    'linkbux': 'LinkBux',
    'rewardoo': 'Rewardoo'
  };
  
  // 排名样式配置
  const getRankStyle = (rank) => {
    if (rank === 1) {
      return {
        bg: 'linear-gradient(135deg, #fbbf24 0%, #f59e0b 100%)',
        color: '#fff',
        icon: '🥇',
        border: '2px solid #fbbf24'
      };
    } else if (rank === 2) {
      return {
        bg: 'linear-gradient(135deg, #94a3b8 0%, #64748b 100%)',
        color: '#fff',
        icon: '🥈',
        border: '2px solid #94a3b8'
      };
    } else if (rank === 3) {
      return {
        bg: 'linear-gradient(135deg, #cd7f32 0%, #a0522d 100%)',
        color: '#fff',
        icon: '🥉',
        border: '2px solid #cd7f32'
      };
    } else {
      return {
        bg: 'var(--bg-tertiary)',
        color: 'var(--text-primary)',
        icon: `#${rank}`,
        border: '1px solid var(--border-medium)'
      };
    }
  };
  
  rankingList.innerHTML = data.map(item => {
    const rankStyle = getRankStyle(item.rank);
    const platformName = platformNames[item.affiliate_name?.toLowerCase()] || item.affiliate_name || '-';
    
    return `
      <div style="background: var(--bg-card); border: ${rankStyle.border}; border-radius: 16px; padding: 20px; transition: all 0.3s; box-shadow: var(--shadow-sm);" 
           onmouseover="this.style.transform='translateY(-2px)'; this.style.boxShadow='var(--shadow-md)'" 
           onmouseout="this.style.transform='translateY(0)'; this.style.boxShadow='var(--shadow-sm)'">
        <div style="display: flex; gap: 16px; align-items: start;">
          <!-- 排名徽章 -->
          <div style="flex-shrink: 0; width: 56px; height: 56px; border-radius: 12px; background: ${rankStyle.bg}; display: flex; align-items: center; justify-content: center; font-size: 24px; font-weight: 700; color: ${rankStyle.color}; box-shadow: 0 4px 12px rgba(0,0,0,0.15);">
            ${rankStyle.icon}
          </div>
          
          <!-- 内容区域 -->
          <div style="flex: 1; min-width: 0;">
            <!-- 商家名称 -->
            <div style="font-size: 18px; font-weight: 600; color: var(--text-primary); margin-bottom: 8px; line-height: 1.4;">
              ${item.merchant_name || '未知商家'}
            </div>
            
            <!-- 商家ID -->
            <div style="font-size: 12px; color: var(--text-secondary); margin-bottom: 12px;">
              <span style="opacity: 0.7;">商家ID:</span> 
              <strong style="color: var(--accent); font-weight: 600;">${item.merchant_id || '-'}</strong>
            </div>
            
            <!-- 指标网格 -->
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin-top: 12px;">
              <!-- EPC -->
              <div style="background: var(--bg-tertiary); border-radius: 8px; padding: 12px; border-left: 3px solid #10b981;">
                <div style="font-size: 11px; color: var(--text-secondary); margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.5px;">EPC</div>
                <div style="font-size: 20px; font-weight: 700; color: #10b981;">$${item.epc.toFixed(2)}</div>
              </div>
              
              <!-- CPC -->
              <div style="background: var(--bg-tertiary); border-radius: 8px; padding: 12px; border-left: 3px solid #3b82f6;">
                <div style="font-size: 11px; color: var(--text-secondary); margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.5px;">CPC</div>
                <div style="font-size: 20px; font-weight: 700; color: #3b82f6;">$${item.cpc.toFixed(2)}</div>
              </div>
              
              <!-- 联盟平台 -->
              <div style="background: var(--bg-tertiary); border-radius: 8px; padding: 12px; border-left: 3px solid #8b5cf6;">
                <div style="font-size: 11px; color: var(--text-secondary); margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.5px;">联盟平台</div>
                <div style="font-size: 16px; font-weight: 600; color: #8b5cf6;">${platformName}</div>
              </div>
              
              <!-- 推广人数 -->
              <div style="background: var(--bg-tertiary); border-radius: 8px; padding: 12px; border-left: 3px solid #f59e0b;">
                <div style="font-size: 11px; color: var(--text-secondary); margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.5px;">推广人数</div>
                <div style="font-size: 16px; font-weight: 600; color: #f59e0b;">
                  <span style="font-size: 14px; margin-right: 4px;">👥</span>${item.promoter_count || 0}人
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

// 显示稳定广告榜单
function displayStableAdsRanking(data, meta, errorMessage) {
  const stableRankingList = document.getElementById('stableRankingList');
  
  if (!stableRankingList) return;
  
  const stableRankingDateRange = document.getElementById('stableRankingDateRange');
  if (stableRankingDateRange) {
    if (meta && meta.date_range) {
      stableRankingDateRange.textContent = `时间范围: ${meta.date_range.start} 至 ${meta.date_range.end}`;
    } else {
      stableRankingDateRange.textContent = '';
    }
  }
  
  if (errorMessage) {
    stableRankingList.innerHTML = `<div style="text-align: center; padding: 20px; color: var(--text-secondary);">${errorMessage}</div>`;
    return;
  }
  
  if (!data || data.length === 0) {
    stableRankingList.innerHTML = '<div style="text-align: center; padding: 20px; color: var(--text-secondary);">暂无稳定广告数据（ROI > 3 且 推广人数 ≥ 5的广告系列）</div>';
    return;
  }
  
  // 联盟平台名称映射
  const platformNames = {
    'linkhaitao': 'LinkHaitao',
    'partnermatic': 'PartnerMatic',
    'linkbux': 'LinkBux',
    'rewardoo': 'Rewardoo'
  };
  
  // 排名样式配置（稳定广告使用不同的颜色主题）
  const getRankStyle = (rank) => {
    if (rank === 1) {
      return {
        badgeBg: 'linear-gradient(135deg, #34d399 0%, #059669 100%)',
        badgeColor: '#fff',
        border: '1px solid rgba(52, 211, 153, 0.45)',
        shadow: '0 12px 28px rgba(16, 185, 129, 0.25)',
        accent: '#34d399'
      };
    } else if (rank === 2) {
      return {
        badgeBg: 'linear-gradient(135deg, #93c5fd 0%, #3b82f6 100%)',
        badgeColor: '#fff',
        border: '1px solid rgba(59, 130, 246, 0.4)',
        shadow: '0 12px 28px rgba(59, 130, 246, 0.18)',
        accent: '#60a5fa'
      };
    } else if (rank === 3) {
      return {
        badgeBg: 'linear-gradient(135deg, #c4b5fd 0%, #8b5cf6 100%)',
        badgeColor: '#fff',
        border: '1px solid rgba(139, 92, 246, 0.4)',
        shadow: '0 12px 28px rgba(139, 92, 246, 0.18)',
        accent: '#a78bfa'
      };
    } else {
      return {
        badgeBg: 'rgba(45, 55, 72, 0.6)',
        badgeColor: 'var(--text-primary)',
        border: '1px solid var(--border-medium)',
        shadow: '0 10px 24px rgba(0,0,0,0.22)',
        accent: 'var(--accent)'
      };
    }
  };
  
  stableRankingList.innerHTML = data.map(item => {
    const rankStyle = getRankStyle(item.rank);
    const platformName = platformNames[item.affiliate_name?.toLowerCase()] || item.affiliate_name || '-';
    
    return `
      <div style="background: var(--bg-card); border: ${rankStyle.border}; border-radius: 20px; padding: 24px; display: flex; flex-direction: column; gap: 20px; position: relative; overflow: hidden; box-shadow: ${rankStyle.shadow}; transition: transform 0.25s ease, box-shadow 0.25s ease;"
           onmouseover="this.style.transform='translateY(-6px)'; this.style.boxShadow='0 18px 35px rgba(0,0,0,0.35)'"
           onmouseout="this.style.transform='translateY(0)'; this.style.boxShadow='${rankStyle.shadow}'">
        <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 18px;">
          <div style="display: flex; align-items: flex-start; gap: 16px;">
            <div style="width: 48px; height: 48px; border-radius: 16px; background: ${rankStyle.badgeBg}; color: ${rankStyle.badgeColor}; font-size: 24px; font-weight: 700; display: flex; align-items: center; justify-content: center; box-shadow: inset 0 0 12px rgba(255, 255, 255, 0.15);">
              ${item.rank <= 3 ? (item.rank === 1 ? '🥇' : item.rank === 2 ? '🥈' : '🥉') : `#${item.rank}`}
            </div>
            <div>
              <div style="font-size: 18px; font-weight: 600; color: var(--text-primary); letter-spacing: 0.2px; margin-bottom: 6px;">
                ${item.merchant_name || '未知商家'}
              </div>
              <div style="font-size: 12px; color: var(--text-secondary); display: flex; gap: 10px; align-items: center;">
                <span style="opacity: 0.7;">商家ID:</span>
                <span style="color: ${rankStyle.accent}; font-weight: 600; letter-spacing: 0.4px;">${item.merchant_id || '-'}</span>
              </div>
            </div>
          </div>
          <div style="text-align: right; min-width: 120px;">
            <div style="font-size: 11px; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.6px;">联盟平台</div>
            <div style="margin-top: 8px; font-size: 16px; font-weight: 600; color: ${rankStyle.accent};">${platformName}</div>
          </div>
        </div>
        <div style="display: flex; flex-wrap: wrap; gap: 12px;">
          <div style="flex: 1; min-width: 140px; background: rgba(52, 211, 153, 0.12); border: 1px solid rgba(52, 211, 153, 0.25); border-radius: 14px; padding: 14px 16px;">
            <div style="font-size: 11px; color: rgba(52, 211, 153, 0.8); letter-spacing: 0.6px; text-transform: uppercase; margin-bottom: 6px;">EPC</div>
            <div style="font-size: 22px; font-weight: 700; color: #34d399;">$${item.epc.toFixed(2)}</div>
          </div>
          <div style="flex: 1; min-width: 140px; background: rgba(59, 130, 246, 0.12); border: 1px solid rgba(59, 130, 246, 0.25); border-radius: 14px; padding: 14px 16px;">
            <div style="font-size: 11px; color: rgba(59, 130, 246, 0.8); letter-spacing: 0.6px; text-transform: uppercase; margin-bottom: 6px;">CPC</div>
            <div style="font-size: 22px; font-weight: 700; color: #60a5fa;">$${item.cpc.toFixed(2)}</div>
          </div>
          <div style="flex: 1; min-width: 140px; background: rgba(16, 185, 129, 0.12); border: 1px solid rgba(16, 185, 129, 0.22); border-radius: 14px; padding: 14px 16px;">
            <div style="font-size: 11px; color: rgba(16, 185, 129, 0.8); letter-spacing: 0.6px; text-transform: uppercase; margin-bottom: 6px;">ROI</div>
            <div style="font-size: 22px; font-weight: 700; color: #10b981;">${item.roi.toFixed(2)}</div>
          </div>
          <div style="flex: 1; min-width: 140px; background: rgba(245, 158, 11, 0.12); border: 1px solid rgba(245, 158, 11, 0.25); border-radius: 14px; padding: 14px 16px;">
            <div style="font-size: 11px; color: rgba(245, 158, 11, 0.9); letter-spacing: 0.6px; text-transform: uppercase; margin-bottom: 6px;">推广人数</div>
            <div style="font-size: 18px; font-weight: 600; color: #fbbf24; display: flex; align-items: center; gap: 6px;">
              <span style="font-size: 16px;">👥</span>${item.promoter_count || 0}人
            </div>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

