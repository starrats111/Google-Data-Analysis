// 提现管理模块

// 初始化提现管理页面
function initWithdrawalManagement() {
  console.log('初始化提现管理页面');
  
  // 设置默认日期为本月
  setWithdrawalDateRange('thisMonth');
  
  // 设置快捷日期按钮
  document.querySelectorAll('.btn-quick-date').forEach(btn => {
    btn.addEventListener('click', function() {
      const days = this.dataset.days;
      const type = this.dataset.type;
      
      // 移除所有按钮的 active 类
      document.querySelectorAll('.btn-quick-date').forEach(b => b.classList.remove('active'));
      // 添加当前按钮的 active 类
      this.classList.add('active');
      
      // 禁用所有快捷按钮，防止重复点击
      document.querySelectorAll('.btn-quick-date').forEach(b => b.disabled = true);
      
      if (type === 'all') {
        document.getElementById('withdrawalStartDate').value = '';
        document.getElementById('withdrawalEndDate').value = '';
      } else if (type === 'thisMonth') {
        setWithdrawalDateRange('thisMonth');
      } else if (type === 'lastMonth') {
        setWithdrawalDateRange('lastMonth');
      } else {
        const endDate = new Date();
        const startDate = new Date();
        startDate.setDate(endDate.getDate() - parseInt(days));
        document.getElementById('withdrawalStartDate').value = startDate.toISOString().split('T')[0];
        document.getElementById('withdrawalEndDate').value = endDate.toISOString().split('T')[0];
      }
      
      // 加载数据，完成后恢复按钮状态
      loadWithdrawalData().finally(() => {
        document.querySelectorAll('.btn-quick-date').forEach(b => b.disabled = false);
      });
    });
  });
  
  // 加载数据
  loadWithdrawalData();
}

// 设置提现日期范围
function setWithdrawalDateRange(type) {
  const now = new Date();
  let startDate, endDate;
  
  if (type === 'thisMonth') {
    // 本月：从本月1号到今天
    startDate = new Date(now.getFullYear(), now.getMonth(), 1);
    endDate = now;
  } else if (type === 'lastMonth') {
    // 上月：上月1号到上月最后一天
    startDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    endDate = new Date(now.getFullYear(), now.getMonth(), 0);
  }
  
  document.getElementById('withdrawalStartDate').value = startDate.toISOString().split('T')[0];
  document.getElementById('withdrawalEndDate').value = endDate.toISOString().split('T')[0];
}

// 加载提现数据
async function loadWithdrawalData() {
  try {
    // 显示加载状态
    const container = document.getElementById('withdrawalByAccountContainer');
    container.innerHTML = `
      <div style="text-align: center; padding: 60px; color: var(--text-secondary);">
        <div style="font-size: 48px; margin-bottom: 16px;">⏳</div>
        <div style="font-size: 16px;">加载中...</div>
      </div>
    `;
    
    const startDate = document.getElementById('withdrawalStartDate').value;
    const endDate = document.getElementById('withdrawalEndDate').value;
    
    let url = '/api/super-admin/withdrawal/summary';
    const params = new URLSearchParams();
    if (startDate) params.append('startDate', startDate);
    if (endDate) params.append('endDate', endDate);
    if (params.toString()) url += '?' + params.toString();
    
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${localStorage.getItem('token')}`
      }
    });
    
    const result = await response.json();
    
    if (result.success) {
      const data = result.data;
      
      // 更新汇总卡片
      document.getElementById('withdrawalAvailableAmount').textContent = 
        '$' + (data.totals.availableToWithdraw || 0).toFixed(2);
      document.getElementById('withdrawalProcessingAmount').textContent = 
        '$' + (data.totals.processingAmount || 0).toFixed(2);
      document.getElementById('withdrawalTotalPaid').textContent = 
        '$' + (data.totals.withdrawnAmount || 0).toFixed(2);
      
      // 加载按账号分组的提现历史
      loadWithdrawalByAccount(startDate, endDate);
    } else {
      console.error('加载失败:', result.message);
      alert('加载失败: ' + result.message);
    }
  } catch (error) {
    console.error('加载提现数据失败:', error);
    alert('加载失败: ' + error.message);
  }
}

// 加载按账号分组的提现历史
async function loadWithdrawalByAccount(startDate, endDate) {
  try {
    let url = '/api/super-admin/withdrawal/payment-history';
    const params = new URLSearchParams();
    if (startDate) params.append('startDate', startDate);
    if (endDate) params.append('endDate', endDate);
    if (params.toString()) url += '?' + params.toString();
    
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${localStorage.getItem('token')}`
      }
    });
    
    const result = await response.json();
    
    if (result.success && result.data) {
      renderWithdrawalByAccount(result.data.accountPayments || []);
    } else {
      document.getElementById('withdrawalByAccountContainer').innerHTML = `
        <div style="text-align: center; padding: 40px; color: var(--text-secondary);">
          ${result.message || '暂无数据'}
        </div>
      `;
    }
  } catch (error) {
    console.error('加载提现历史失败:', error);
    document.getElementById('withdrawalByAccountContainer').innerHTML = `
      <div style="text-align: center; padding: 40px; color: var(--text-secondary);">
        加载失败: ${error.message}
      </div>
    `;
  }
}

// 渲染按账号分组的提现历史
function renderWithdrawalByAccount(accountPayments) {
  const container = document.getElementById('withdrawalByAccountContainer');
  
  if (!accountPayments || accountPayments.length === 0) {
    container.innerHTML = `
      <div style="text-align: center; padding: 40px; color: var(--text-secondary);">
        暂无提现记录
      </div>
    `;
    return;
  }
  
  container.innerHTML = accountPayments.map((account, index) => `
    <div class="account-card" style="background: var(--card-bg); border-radius: 8px; overflow: hidden; margin-bottom: 16px; border: 1px solid var(--border-color); transition: all 0.3s ease;">
      <!-- 账号信息头部（可点击展开/收起） -->
      <div class="account-header" onclick="toggleAccountDetails(${index})" style="padding: 20px; cursor: pointer; background: linear-gradient(135deg, rgba(99, 102, 241, 0.1) 0%, rgba(79, 70, 229, 0.05) 100%); transition: background 0.2s ease;">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <div style="flex: 1;">
            <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 8px;">
              <h3 style="margin: 0; color: var(--text-primary); font-size: 18px;">
                🏢 ${account.account_name} ${account.affiliate_name ? `(${account.affiliate_name})` : ''}
              </h3>
              <span class="expand-icon" id="expand-icon-${index}" style="color: var(--text-secondary); font-size: 20px; transition: transform 0.3s ease;">▼</span>
            </div>
            <div style="color: var(--text-secondary); font-size: 14px;">
              👤 ${account.username} • 📧 ${account.email}
            </div>
          </div>
          <div style="display: flex; gap: 30px;">
            <div style="text-align: center;">
              <div style="font-size: 12px; color: var(--text-secondary); margin-bottom: 4px;">💰 可提现</div>
              <div style="font-size: 20px; font-weight: 600; color: #10b981;">
                $${(account.available_amount || 0).toFixed(2)}
              </div>
            </div>
            <div style="text-align: center;">
              <div style="font-size: 12px; color: var(--text-secondary); margin-bottom: 4px;">⏳ 提现中</div>
              <div style="font-size: 20px; font-weight: 600; color: #f59e0b;">
                $0.00
              </div>
            </div>
            <div style="text-align: center;">
              <div style="font-size: 12px; color: var(--text-secondary); margin-bottom: 4px;">✅ 已提现</div>
              <div style="font-size: 20px; font-weight: 600; color: #6366f1;">
                $${(account.total_amount || 0).toFixed(2)}
              </div>
            </div>
          </div>
        </div>
      </div>
      
      <!-- 提现记录详情（默认隐藏） -->
      <div class="account-details" id="account-details-${index}" style="display: none; border-top: 1px solid var(--border-color);">
        <div style="overflow-x: auto;">
          <table class="data-table" style="margin: 0;">
            <thead>
              <tr>
                <th>请求日期</th>
                <th>支付日期</th>
                <th>Payment ID</th>
                <th>状态</th>
                <th>支付方式</th>
                <th>金额($)</th>
              </tr>
            </thead>
            <tbody>
              ${account.payments && account.payments.length > 0 ? account.payments.map(payment => `
                <tr>
                  <td>${payment.request_date ? formatDate(payment.request_date) : '-'}</td>
                  <td>${payment.paid_date ? formatDate(payment.paid_date) : '-'}</td>
                  <td>${payment.payment_id || '-'}</td>
                  <td>
                    <span class="status-badge status-${(payment.status || 'pending').toLowerCase()}">
                      ${getStatusText(payment.status)}
                    </span>
                  </td>
                  <td>${payment.payment_type || 'Bank'}</td>
                  <td style="font-weight: 600; color: #10b981;">$${(payment.amount || 0).toFixed(2)}</td>
                </tr>
              `).join('') : '<tr><td colspan="6" style="text-align: center; padding: 20px; color: var(--text-secondary);">暂无提现记录</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `).join('');
}

// 切换账号详情显示/隐藏
function toggleAccountDetails(index) {
  const detailsEl = document.getElementById(`account-details-${index}`);
  const iconEl = document.getElementById(`expand-icon-${index}`);
  
  if (detailsEl.style.display === 'none') {
    detailsEl.style.display = 'block';
    iconEl.style.transform = 'rotate(180deg)';
  } else {
    detailsEl.style.display = 'none';
    iconEl.style.transform = 'rotate(0deg)';
  }
}

// 获取状态文本
function getStatusText(status) {
  const statusMap = {
    'Paid': '已支付',
    'Processing': '处理中',
    'Pending': '待处理',
    'Rejected': '已拒绝'
  };
  return statusMap[status] || status;
}

// 格式化日期
function formatDate(dateStr) {
  if (!dateStr) return '-';
  const date = new Date(dateStr);
  return date.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

// 应用日期筛选
function applyWithdrawalDateFilter() {
  // 禁用筛选按钮，防止重复点击
  const filterBtn = event?.target;
  if (filterBtn) {
    filterBtn.disabled = true;
    filterBtn.innerHTML = '⏳ 加载中...';
  }
  
  loadWithdrawalData().finally(() => {
    // 恢复按钮状态
    if (filterBtn) {
      filterBtn.disabled = false;
      filterBtn.innerHTML = '🔍 筛选';
    }
  });
}

// 导出提现记录
async function exportWithdrawalRecords() {
  try {
    const startDate = document.getElementById('withdrawalStartDate').value;
    const endDate = document.getElementById('withdrawalEndDate').value;
    
    let url = '/api/super-admin/withdrawal/export';
    const params = new URLSearchParams();
    if (startDate) params.append('startDate', startDate);
    if (endDate) params.append('endDate', endDate);
    if (params.toString()) url += '?' + params.toString();
    
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${localStorage.getItem('token')}`
      }
    });
    
    if (response.ok) {
      const blob = await response.blob();
      const downloadUrl = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = downloadUrl;
      a.download = `withdrawal_records_${new Date().toISOString().split('T')[0]}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(downloadUrl);
      alert('导出成功');
    } else {
      alert('导出失败');
    }
  } catch (error) {
    console.error('导出失败:', error);
    alert('导出失败: ' + error.message);
  }
}

// 同步 PM 订单数据（快速更新）
async function syncPMOrders() {
  if (!confirm('确定要更新所有 PartnerMatic 账号的结算信息吗？\n\n这个操作会从现有订单数据中提取结算信息，通常只需几秒钟。')) {
    return;
  }
  
  try {
    console.log('正在更新数据，请稍候...');
    
    // 显示加载状态
    const syncBtn = event.target;
    const originalText = syncBtn.innerHTML;
    syncBtn.disabled = true;
    syncBtn.innerHTML = '⏳ 更新中...';
    
    const response = await fetch('/api/super-admin/withdrawal/quick-update', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${localStorage.getItem('token')}`,
        'Content-Type': 'application/json'
      }
    });
    
    const result = await response.json();
    
    // 恢复按钮状态
    syncBtn.disabled = false;
    syncBtn.innerHTML = originalText;
    
    if (result.success) {
      alert(result.message);
      
      // 刷新页面数据
      setTimeout(() => {
        loadWithdrawalData();
      }, 1000);
    } else {
      alert('更新失败: ' + result.message);
    }
  } catch (error) {
    console.error('更新失败:', error);
    alert('更新失败: ' + error.message);
    
    // 恢复按钮状态
    if (event && event.target) {
      event.target.disabled = false;
      event.target.innerHTML = '🔄 同步数据';
    }
  }
}
