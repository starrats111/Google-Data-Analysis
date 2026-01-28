import React, { useState, useEffect } from 'react'
import { Card, Tabs, Upload, Button, Select, DatePicker, Table, message, Modal, Space, Popconfirm, InputNumber, Divider } from 'antd'
import { UploadOutlined, PlayCircleOutlined, DeleteOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { useNavigate } from 'react-router-dom'
import api from '../services/api'
import { useAuth } from '../store/authStore'

const { Option } = Select

const UploadPage = () => {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [googleAccounts, setGoogleAccounts] = useState([])
  const [affiliateAccounts, setAffiliateAccounts] = useState([])
  const [platforms, setPlatforms] = useState([])
  const [uploadHistory, setUploadHistory] = useState([])
  const [selectedAccount, setSelectedAccount] = useState(null)
  const [selectedPlatform, setSelectedPlatform] = useState(null)  // 用于谷歌广告数据
  const [selectedDate, setSelectedDate] = useState(dayjs().subtract(1, 'day'))
  const [analysisModalVisible, setAnalysisModalVisible] = useState(false)
  const [selectedGoogleUpload, setSelectedGoogleUpload] = useState(null)
  const [selectedAffiliateUpload, setSelectedAffiliateUpload] = useState(null)
  const [analysisLoading, setAnalysisLoading] = useState(false)
  // 操作指令相关参数（员工手动输入）
  const [pastSevenDaysOrders, setPastSevenDaysOrders] = useState('')
  const [maxCpcValue, setMaxCpcValue] = useState('')

  useEffect(() => {
    fetchAccounts()
    fetchPlatforms()
    fetchHistory()
  }, [])

  const fetchAccounts = async () => {
    try {
      const response = await api.get('/api/affiliate/accounts')
      setAffiliateAccounts(response.data)
    } catch (error) {
      message.error('获取账号列表失败')
    }
  }

  const fetchPlatforms = async () => {
    try {
      const response = await api.get('/api/affiliate/platforms')
      setPlatforms(response.data || [])
    } catch (error) {
      console.error('获取平台列表失败:', error)
      message.error('获取平台列表失败，请刷新页面重试')
      setPlatforms([]) // 确保设置为空数组，避免undefined错误
    }
  }

  const fetchHistory = async () => {
    try {
      const response = await api.get('/api/upload/history')
      setUploadHistory(response.data)
    } catch (error) {
      message.error('获取上传历史失败')
    }
  }

  const handleStartAnalysis = () => {
    // 检查是否有可用的上传记录
    const googleUploads = uploadHistory.filter(u => u.upload_type === 'google_ads')
    const affiliateUploads = uploadHistory.filter(u => u.upload_type === 'affiliate')
    
    if (googleUploads.length === 0) {
      message.warning('请先上传表1（谷歌广告数据）')
      return
    }
    if (affiliateUploads.length === 0) {
      message.warning('请先上传表2（联盟数据）')
      return
    }
    
    setAnalysisModalVisible(true)
    // 默认选择最新的上传记录
    if (!selectedGoogleUpload && googleUploads.length > 0) {
      setSelectedGoogleUpload(googleUploads[0].id)
    }
    if (!selectedAffiliateUpload && affiliateUploads.length > 0) {
      setSelectedAffiliateUpload(affiliateUploads[0].id)
    }
  }

  const handleProcessAnalysis = async () => {
    if (!selectedGoogleUpload || !selectedAffiliateUpload) {
      message.error('请选择表1和表2')
      return
    }

    // 获取选中的上传记录
    const googleUpload = uploadHistory.find(u => u.id === selectedGoogleUpload)
    const affiliateUpload = uploadHistory.find(u => u.id === selectedAffiliateUpload)
    const affiliateAccountId = affiliateUpload?.affiliate_account_id

    if (!affiliateAccountId) {
      message.error('联盟数据必须关联联盟账号')
      return
    }

    // 检查平台匹配
    if (googleUpload?.platform_id && affiliateUpload?.affiliate_account_id) {
      // 获取联盟账号的平台ID
      const account = affiliateAccounts.find(acc => acc.id === affiliateAccountId)
      if (account && account.platform_id !== googleUpload.platform_id) {
        message.error('平台不匹配：表1和表2必须属于同一联盟平台')
        return
      }
    }

    setAnalysisLoading(true)
    try {
      // 构建请求参数
      const requestData = {
        google_ads_upload_id: selectedGoogleUpload,
        affiliate_upload_id: selectedAffiliateUpload,
        affiliate_account_id: affiliateAccountId
      }
      
      // 如果输入了全局值，添加到请求中
      // 注意：这里使用全局值，后续可以根据商家ID分别设置
      if (pastSevenDaysOrders !== '' && pastSevenDaysOrders !== null) {
        requestData.past_seven_days_orders_global = parseFloat(pastSevenDaysOrders)
      }
      if (maxCpcValue !== '' && maxCpcValue !== null) {
        requestData.max_cpc_global = parseFloat(maxCpcValue)
      }
      
      const response = await api.post('/api/analysis/process', requestData)
      
      const totalRows = response.data.total_rows || 0
      if (totalRows === 0 && response.data.diagnosis) {
        // 如果结果为0行，显示诊断信息
        const diagnosis = response.data.diagnosis
        let diagnosisMsg = '分析结果为0行。\n'
        diagnosisMsg += `表1行数: ${diagnosis.google_rows || 0}\n`
        diagnosisMsg += `表2行数: ${diagnosis.affiliate_rows || 0}\n`
        if (diagnosis.google_has_merchant_id) {
          diagnosisMsg += `表1有效商家ID: ${diagnosis.google_valid_merchant_ids || 0} (唯一: ${diagnosis.google_unique_merchant_ids || 0})\n`
          if (diagnosis.google_sample_ids) {
            diagnosisMsg += `表1商家ID示例: ${diagnosis.google_sample_ids.join(', ')}\n`
          }
        }
        if (diagnosis.affiliate_has_merchant_id) {
          diagnosisMsg += `表2有效商家ID: ${diagnosis.affiliate_valid_merchant_ids || 0} (唯一: ${diagnosis.affiliate_unique_merchant_ids || 0})\n`
          if (diagnosis.affiliate_sample_ids) {
            diagnosisMsg += `表2商家ID示例: ${diagnosis.affiliate_sample_ids.join(', ')}\n`
          }
        }
        diagnosisMsg += '\n请检查：\n1. 表1和表2的商家ID是否匹配\n2. 商家ID格式是否一致\n3. 查看后端控制台日志获取更多信息'
        message.warning(diagnosisMsg, 10) // 显示10秒
      } else {
        message.success(`分析完成！共处理 ${totalRows} 行数据`)
      }
      setAnalysisModalVisible(false)
      // 延迟跳转，确保消息显示后再跳转
      setTimeout(() => {
        navigate('/analysis')
      }, 1000)
    } catch (error) {
      message.error(error.response?.data?.detail || '分析失败，请检查数据格式')
      console.error('分析错误:', error)
    } finally {
      setAnalysisLoading(false)
    }
  }

  const handleGoogleUpload = async (file) => {
    if (!selectedPlatform) {
      message.error('请先选择联盟平台')
      return false
    }

    const formData = new FormData()
    formData.append('file', file)
    formData.append('upload_date', selectedDate.format('YYYY-MM-DD'))
    formData.append('platform_id', selectedPlatform)

    try {
      await api.post('/api/upload/google-ads', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      message.success('上传成功！')
      fetchHistory()
      return false
    } catch (error) {
      message.error(error.response?.data?.detail || '上传失败')
      return false
    }
  }

  const handleAffiliateUpload = async (file) => {
    if (!selectedAccount) {
      message.error('请先选择联盟账号')
      return false
    }

    const formData = new FormData()
    formData.append('file', file)
    formData.append('upload_date', selectedDate.format('YYYY-MM-DD'))
    formData.append('affiliate_account_id', selectedAccount)

    try {
      await api.post('/api/upload/affiliate', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      message.success('上传成功！')
      fetchHistory()
      return false
    } catch (error) {
      message.error(error.response?.data?.detail || '上传失败')
      return false
    }
  }

  const handleDeleteUpload = async (uploadId) => {
    try {
      await api.delete(`/api/upload/${uploadId}`)
      message.success('删除成功，相关分析结果已自动删除')
      fetchHistory()
      // 如果删除的是选中的上传记录，清空选择
      if (selectedGoogleUpload === uploadId) {
        setSelectedGoogleUpload(null)
      }
      if (selectedAffiliateUpload === uploadId) {
        setSelectedAffiliateUpload(null)
      }
    } catch (error) {
      message.error(error.response?.data?.detail || '删除失败')
    }
  }

  const historyColumns = [
    { title: '文件名', dataIndex: 'file_name', key: 'file_name' },
    { title: '类型', dataIndex: 'upload_type', key: 'upload_type', render: (type) => {
      return type === 'google_ads' ? '表1（谷歌广告）' : '表2（联盟数据）'
    }},
    { title: '联盟平台', key: 'platform', render: (_, record) => {
      if (record.upload_type === 'google_ads' && record.platform_id) {
        const platform = platforms.find(p => p.id === record.platform_id)
        return platform ? platform.platform_name : '-'
      } else if (record.upload_type === 'affiliate' && record.affiliate_account_id) {
        const account = affiliateAccounts.find(acc => acc.id === record.affiliate_account_id)
        return account ? account.platform?.platform_name || '-' : '-'
      }
      return '-'
    }},
    { title: '数据日期', dataIndex: 'upload_date', key: 'upload_date', render: (date) => {
      if (!date) return '-'
      return typeof date === 'string' ? date : date
    }},
    { title: '上传时间', dataIndex: 'uploaded_at', key: 'uploaded_at', render: (time) => {
      if (!time) return '-'
      if (typeof time === 'string') {
        return time.replace('T', ' ').substring(0, 19)
      }
      return time
    }},
    { title: '状态', dataIndex: 'status', key: 'status', render: (status) => {
      const statusMap = {
        'completed': '已完成',
        'processing': '处理中',
        'failed': '失败'
      }
      return statusMap[status] || status
    }},
    {
      title: '操作',
      key: 'action',
      width: 100,
      render: (_, record) => (
        <Popconfirm
          title="确定要删除此上传记录吗？"
          description="删除后无法恢复，如果该记录已用于分析，相关的分析结果也会被自动删除。"
          onConfirm={() => handleDeleteUpload(record.id)}
          okText="确定"
          cancelText="取消"
        >
          <Button
            type="link"
            danger
            icon={<DeleteOutlined />}
            size="small"
          >
            删除
          </Button>
        </Popconfirm>
      ),
    },
  ]

  // 获取表1和表2的上传记录
  const googleUploads = uploadHistory.filter(u => u.upload_type === 'google_ads')
  const affiliateUploads = uploadHistory.filter(u => u.upload_type === 'affiliate')

  const tabItems = [
    {
      key: 'google',
      label: '谷歌广告数据（表1）',
      children: (
        <Card>
          <div style={{ marginBottom: 16 }}>
            <Select
              placeholder="选择联盟平台"
              style={{ width: 300, marginRight: 16 }}
              value={selectedPlatform}
              onChange={setSelectedPlatform}
            >
              {platforms.map(platform => (
                <Option key={platform.id} value={platform.id}>
                  {platform.platform_name}
                </Option>
              ))}
            </Select>
            <DatePicker
              value={selectedDate}
              onChange={setSelectedDate}
              format="YYYY-MM-DD"
              style={{ marginRight: 16 }}
            />
          </div>
          {platforms.length === 0 && (
            <p style={{ color: '#ff4d4f', marginBottom: 16 }}>
              请先创建联盟平台
            </p>
          )}
          <Upload
            beforeUpload={handleGoogleUpload}
            showUploadList={false}
            accept=".xlsx,.xls,.csv"
            disabled={!selectedPlatform}
          >
            <Button
              icon={<UploadOutlined />}
              type="primary"
              size="large"
              disabled={!selectedPlatform}
            >
              上传文件
            </Button>
          </Upload>
        </Card>
      ),
    },
    {
      key: 'affiliate',
      label: '联盟数据（表2）',
      children: (
        <Card>
          <div style={{ marginBottom: 16 }}>
            <Select
              placeholder="选择联盟账号"
              style={{ width: 300, marginRight: 16 }}
              value={selectedAccount}
              onChange={setSelectedAccount}
            >
              {affiliateAccounts.map(acc => (
                <Option key={acc.id} value={acc.id}>
                  {acc.platform?.platform_name} - {acc.account_name}
                </Option>
              ))}
            </Select>
            <DatePicker
              value={selectedDate}
              onChange={setSelectedDate}
              format="YYYY-MM-DD"
            />
          </div>
          {affiliateAccounts.length === 0 && (
            <p style={{ color: '#ff4d4f', marginBottom: 16 }}>
              请先创建联盟账号
            </p>
          )}
          <Upload
            beforeUpload={handleAffiliateUpload}
            showUploadList={false}
            accept=".xlsx,.xls,.csv"
            disabled={!selectedAccount}
          >
            <Button
              icon={<UploadOutlined />}
              type="primary"
              size="large"
              disabled={!selectedAccount}
            >
              上传文件
            </Button>
          </Upload>
        </Card>
      ),
    },
  ]

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h2>数据上传</h2>
        <Button
          type="primary"
          icon={<PlayCircleOutlined />}
          onClick={handleStartAnalysis}
          disabled={googleUploads.length === 0 || affiliateUploads.length === 0}
        >
          开始分析
        </Button>
      </div>
      <Tabs defaultActiveKey="google" items={tabItems} />

      <Card title="上传历史" style={{ marginTop: 24 }}>
        <Table
          columns={historyColumns}
          dataSource={uploadHistory}
          rowKey="id"
        />
      </Card>

      {/* 分析模态框 */}
      <Modal
        title="开始数据分析"
        open={analysisModalVisible}
        onOk={handleProcessAnalysis}
        onCancel={() => setAnalysisModalVisible(false)}
        okText="开始分析"
        cancelText="取消"
        confirmLoading={analysisLoading}
        width={600}
      >
        <Space direction="vertical" style={{ width: '100%' }} size="large">
          <div>
            <label style={{ display: 'block', marginBottom: 8 }}>选择表1（谷歌广告数据）：</label>
            <Select
              style={{ width: '100%' }}
              placeholder="选择表1文件"
              value={selectedGoogleUpload}
              onChange={setSelectedGoogleUpload}
            >
              {googleUploads.map(upload => {
                const platform = platforms.find(p => p.id === upload.platform_id)
                return (
                  <Option key={upload.id} value={upload.id}>
                    {upload.file_name} ({upload.upload_date}){platform ? ` - ${platform.platform_name}` : ''}
                  </Option>
                )
              })}
            </Select>
          </div>

          <div>
            <label style={{ display: 'block', marginBottom: 8 }}>选择表2（联盟数据）：</label>
            <Select
              style={{ width: '100%' }}
              placeholder="选择表2文件"
              value={selectedAffiliateUpload}
              onChange={setSelectedAffiliateUpload}
            >
              {affiliateUploads.map(upload => {
                const account = affiliateAccounts.find(acc => acc.id === upload.affiliate_account_id)
                return (
                  <Option key={upload.id} value={upload.id}>
                    {upload.file_name} ({upload.upload_date}) - {account ? `${account.platform?.platform_name} - ${account.account_name}` : '未知账号'}
                  </Option>
                )
              })}
            </Select>
          </div>

          <Divider />
          
          <div>
            <label style={{ display: 'block', marginBottom: 8, fontWeight: 'bold' }}>
              操作指令参数（从谷歌中查看后手动输入）：
            </label>
            <Space direction="vertical" style={{ width: '100%' }} size="middle">
              <div>
                <label style={{ display: 'block', marginBottom: 4, fontSize: '13px' }}>
                  过去七天出单天数（全局默认值，可选）：
                </label>
                <InputNumber
                  style={{ width: '100%' }}
                  placeholder="请输入过去七天出单天数（如：4）"
                  min={0}
                  max={7}
                  precision={0}
                  value={pastSevenDaysOrders}
                  onChange={(value) => setPastSevenDaysOrders(value)}
                />
              </div>
              <div>
                <label style={{ display: 'block', marginBottom: 4, fontSize: '13px' }}>
                  最高CPC（全局默认值，可选）：
                </label>
                <InputNumber
                  style={{ width: '100%' }}
                  placeholder="请输入最高CPC（如：0.5）"
                  min={0}
                  precision={2}
                  value={maxCpcValue}
                  onChange={(value) => setMaxCpcValue(value)}
                />
              </div>
              <div style={{ padding: '8px', background: '#e6f7ff', borderRadius: '4px', fontSize: '12px', color: '#666' }}>
                <strong>说明：</strong>这两个值用于生成操作指令。如果不输入，系统将使用默认逻辑（订单数或CPC值）。
              </div>
            </Space>
          </div>

          <Divider />

          <div style={{ padding: '12px', background: '#f0f0f0', borderRadius: '4px' }}>
            <p style={{ margin: 0, fontSize: '12px', color: '#666' }}>
              <strong>提示：</strong>分析将合并表1和表2的数据，计算保守EPC和保守ROI。
              <br />
              <strong>重要：</strong>表1和表2必须属于同一联盟平台才能进行分析。
              <br />
              分析完成后，结果将显示在"分析结果"页面，并自动添加阶段标签和操作指令。
            </p>
          </div>
        </Space>
      </Modal>
    </div>
  )
}

export default UploadPage




