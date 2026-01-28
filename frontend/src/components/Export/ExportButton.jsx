import React, { useState, useEffect } from 'react';
import { Button, message, Modal, DatePicker, Select, Space } from 'antd';
import { DownloadOutlined, LoadingOutlined } from '@ant-design/icons';
import api from '../../services/api';
import dayjs from 'dayjs'

const { RangePicker } = DatePicker;
const { Option } = Select;

const ExportButton = ({ 
  type = 'analysis',  // 'analysis' 或 'dashboard'
  accountId = null,
  platformId = null,
  employeeId = null,
  onExportSuccess
}) => {
  const [loading, setLoading] = useState(false);
  const [visible, setVisible] = useState(false);
  const [dateRange, setDateRange] = useState(null);
  const [selectedAccountId, setSelectedAccountId] = useState(accountId);
  const [selectedPlatformId, setSelectedPlatformId] = useState(platformId);
  const [selectedEmployeeId, setSelectedEmployeeId] = useState(employeeId);
  const [platforms, setPlatforms] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [employees, setEmployees] = useState([]);

  useEffect(() => {
    fetchPlatforms();
    fetchAccounts();
    if (type === 'dashboard') {
      fetchEmployees();
    }
  }, [type]);

  const fetchPlatforms = async () => {
    try {
      const response = await api.get('/api/affiliate/platforms');
      setPlatforms(response.data);
    } catch (error) {
      console.error('获取平台列表失败', error);
    }
  };

  const fetchAccounts = async () => {
    try {
      const response = await api.get('/api/affiliate/accounts');
      setAccounts(response.data);
    } catch (error) {
      console.error('获取账号列表失败', error);
    }
  };

  const fetchEmployees = async () => {
    try {
      const response = await api.get('/api/dashboard/employees');
      setEmployees(response.data);
    } catch (error) {
      console.error('获取员工列表失败', error);
    }
  };

  const handleExport = async () => {
    setLoading(true);
    
    try {
      const params = new URLSearchParams();
      
      if (selectedAccountId) {
        params.append('account_id', selectedAccountId);
      }
      if (selectedPlatformId) {
        params.append('platform_id', selectedPlatformId);
      }
      if (selectedEmployeeId) {
        params.append('employee_id', selectedEmployeeId);
      }
      if (dateRange && dateRange.length === 2) {
        params.append('start_date', dateRange[0].format('YYYY-MM-DD'));
        params.append('end_date', dateRange[1].format('YYYY-MM-DD'));
      }
      
      // 根据类型选择不同的导出接口
      const endpoint = type === 'dashboard' 
        ? `/api/export/dashboard?${params.toString()}`
        : `/api/export/analysis?${params.toString()}`;
      
      // 发起导出请求
      const response = await api.get(endpoint, {
        responseType: 'blob',  // 重要：指定响应类型为blob
      });
      
      // 创建下载链接
      const blob = new Blob([response.data], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      });
      
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      
      // 从响应头获取文件名，或使用默认名称
      const contentDisposition = response.headers['content-disposition'];
      let filename = '分析结果.xlsx';
      if (contentDisposition) {
        const filenameMatch = contentDisposition.match(/filename="?(.+)"?/);
        if (filenameMatch) {
          filename = decodeURIComponent(filenameMatch[1]);
        }
      }
      
      link.setAttribute('download', filename);
      document.body.appendChild(link);
      link.click();
      
      // 清理
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);
      
      message.success('导出成功！');
      setVisible(false);
      onExportSuccess && onExportSuccess();
      
    } catch (error) {
      console.error('导出失败:', error);
      if (error.response?.status === 400) {
        message.error(error.response.data?.detail || '没有可导出的数据');
      } else {
        message.error('导出失败，请稍后重试');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleQuickExport = async () => {
    // 快速导出：使用当前筛选条件，不弹出对话框
    setLoading(true);
    
    try {
      const params = new URLSearchParams();
      
      if (accountId) params.append('account_id', accountId);
      if (platformId) params.append('platform_id', platformId);
      if (employeeId) params.append('employee_id', employeeId);
      
      const endpoint = type === 'dashboard' 
        ? `/api/export/dashboard?${params.toString()}`
        : `/api/export/analysis?${params.toString()}`;
      
      const response = await api.get(endpoint, {
        responseType: 'blob',
      });
      
      const blob = new Blob([response.data], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      });
      
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      
      const contentDisposition = response.headers['content-disposition'];
      let filename = '分析结果.xlsx';
      if (contentDisposition) {
        const filenameMatch = contentDisposition.match(/filename="?(.+)"?/);
        if (filenameMatch) {
          filename = decodeURIComponent(filenameMatch[1]);
        }
      }
      
      link.setAttribute('download', filename);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);
      
      message.success('导出成功！');
      onExportSuccess && onExportSuccess();
      
    } catch (error) {
      console.error('导出失败:', error);
      message.error('导出失败，请稍后重试');
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <Space>
        <Button
          icon={loading ? <LoadingOutlined /> : <DownloadOutlined />}
          onClick={handleQuickExport}
          loading={loading}
        >
          快速导出
        </Button>
        <Button
          icon={<DownloadOutlined />}
          onClick={() => setVisible(true)}
        >
          自定义导出
        </Button>
      </Space>

      <Modal
        title="导出分析结果"
        open={visible}
        onOk={handleExport}
        onCancel={() => setVisible(false)}
        confirmLoading={loading}
        okText="导出"
        cancelText="取消"
      >
        <Space direction="vertical" style={{ width: '100%' }} size="large">
          <div>
            <label>日期范围：</label>
            <RangePicker
              style={{ width: '100%', marginTop: 8 }}
              value={dateRange}
              onChange={setDateRange}
              format="YYYY-MM-DD"
            />
          </div>

          {type === 'dashboard' && (
            <div>
              <label>员工：</label>
              <Select
                style={{ width: '100%', marginTop: 8 }}
                placeholder="选择员工（可选）"
                value={selectedEmployeeId}
                onChange={setSelectedEmployeeId}
                allowClear
              >
                {employees.map(emp => (
                  <Option key={emp.employee_id} value={emp.employee_id}>
                    {emp.username} (ID: {emp.employee_id})
                  </Option>
                ))}
              </Select>
            </div>
          )}

          <div>
            <label>联盟平台：</label>
            <Select
              style={{ width: '100%', marginTop: 8 }}
              placeholder="选择平台（可选）"
              value={selectedPlatformId}
              onChange={setSelectedPlatformId}
              allowClear
            >
              {platforms.map(platform => (
                <Option key={platform.id} value={platform.id}>
                  {platform.platform_name}
                </Option>
              ))}
            </Select>
          </div>

          <div>
            <label>联盟账号：</label>
            <Select
              style={{ width: '100%', marginTop: 8 }}
              placeholder="选择账号（可选）"
              value={selectedAccountId}
              onChange={setSelectedAccountId}
              allowClear
            >
              {accounts.map(acc => (
                <Option key={acc.id} value={acc.id}>
                  {acc.platform?.platform_name} - {acc.account_name}
                </Option>
              ))}
            </Select>
          </div>
        </Space>
      </Modal>
    </>
  );
};

export default ExportButton;

