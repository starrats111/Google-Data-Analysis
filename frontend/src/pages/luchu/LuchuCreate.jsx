/**
 * 露出内容创建页面
 */
import React, { useState, useEffect, useCallback } from 'react'
import { 
  Card, Steps, Form, Input, Select, Button, Row, Col, 
  Spin, message, DatePicker, InputNumber, Image, Space,
  Typography, Alert, Divider, List, Checkbox, Upload, Progress
} from 'antd'
import { 
  LinkOutlined, RobotOutlined, EditOutlined, 
  CheckOutlined, LoadingOutlined, ReloadOutlined,
  PictureOutlined, PlusOutlined, DeleteOutlined, UploadOutlined
} from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { 
  analyzeMerchant, 
  pollAnalyzeTask,
  getAnalyzeTaskStatus,
  generateArticle, 
  createArticle,
  getWebsites,
  getPromptTemplates,
  getProxyImageUrl,
  uploadImage
} from '../../services/luchuApi'
import dayjs from 'dayjs'

const { Title, Text, Paragraph } = Typography
const { TextArea } = Input
const { Step } = Steps

/**
 * SmartImage 组件 - 三重保障确保图片显示
 * 1. 优先使用 Base64（最可靠，无需网络请求）
 * 2. Base64 缺失时，使用后端图片代理（绕过防盗链）
 * 3. 加载失败时，显示友好占位符和原始 URL 链接
 */
const SmartImage = ({ img, width = 100, height = 100, style = {}, onClick }) => {
  const [loadError, setLoadError] = useState(false)
  const [currentSrc, setCurrentSrc] = useState('')
  const [retryCount, setRetryCount] = useState(0)
  const [isLoading, setIsLoading] = useState(true)
  const imgRef = React.useRef(null)
  
  // 计算图片源
  useEffect(() => {
    setLoadError(false)
    setRetryCount(0)
    setIsLoading(true)
    
    // 优先使用 Base64
    if (img.base64 && img.base64.startsWith('data:')) {
      setCurrentSrc(img.base64)
      return
    }
    
    // 其次使用代理 URL
    const originalUrl = img.url || img.src || ''
    if (originalUrl) {
      // 如果是已上传的图片（服务器路径），直接使用
      if (originalUrl.startsWith('/api/luchu/images/uploaded/')) {
        const apiBaseUrl = import.meta.env.VITE_API_BASE_URL || 'https://api.google-data-analysis.top'
        setCurrentSrc(`${apiBaseUrl}${originalUrl}`)
      } else {
        setCurrentSrc(getProxyImageUrl(originalUrl))
      }
      return
    }
    
    // 没有任何图片源
    setLoadError(true)
    setIsLoading(false)
  }, [img])
  
  // 处理加载成功 - 检测是否是占位图（SVG 很小）
  const handleLoad = useCallback((e) => {
    setIsLoading(false)
    const imgEl = e.target
    
    // 检测是否加载成功：自然宽高应该大于 0
    // SVG 占位图通常是 200x200，但真实图片应该有不同尺寸
    if (imgEl.naturalWidth === 0 || imgEl.naturalHeight === 0) {
      setLoadError(true)
      return
    }
    
    // 额外检测：如果图片太小可能是占位图（但要排除缩略图情况）
    // 这里不做强制判断，因为有些图片本身就小
  }, [])
  
  // 处理加载错误
  const handleError = useCallback(() => {
    setIsLoading(false)
    const originalUrl = img.url || img.src || ''
    
    // 如果当前是代理 URL 且失败，尝试直接加载原图
    if (retryCount === 0 && originalUrl && currentSrc.includes('proxy-public')) {
      setRetryCount(1)
      setCurrentSrc(originalUrl)
      return
    }
    
    // 所有尝试都失败，显示占位符
    setLoadError(true)
  }, [img, retryCount, currentSrc])
  
  // 获取原始 URL（用于显示链接）
  const originalUrl = img.url || img.src || ''
  
  // 显示占位符（带可点击链接）
  if (loadError || !currentSrc) {
    return (
      <div 
        onClick={onClick}
        style={{ 
          width, 
          height, 
          display: 'flex', 
          flexDirection: 'column',
          alignItems: 'center', 
          justifyContent: 'center',
          background: 'linear-gradient(135deg, #f5f5f5 0%, #e8e8e8 100%)',
          color: '#999',
          fontSize: 11,
          borderRadius: 4,
          cursor: onClick ? 'pointer' : 'default',
          position: 'relative',
          ...style
        }}
      >
        <PictureOutlined style={{ fontSize: 24, marginBottom: 4, color: '#bbb' }} />
        <span style={{ textAlign: 'center', padding: '0 4px', lineHeight: 1.2 }}>
          {img.alt ? (img.alt.length > 15 ? img.alt.substring(0, 15) + '...' : img.alt) : '图片加载失败'}
        </span>
        {originalUrl && (
          <a 
            href={originalUrl} 
            target="_blank" 
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            style={{ 
              fontSize: 10, 
              color: '#1890ff', 
              marginTop: 2,
              textDecoration: 'underline'
            }}
          >
            查看原图
          </a>
        )}
      </div>
    )
  }
  
  return (
    <div style={{ position: 'relative', width, height }}>
      {isLoading && (
        <div style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#f5f5f5'
        }}>
          <LoadingOutlined style={{ fontSize: 20, color: '#1890ff' }} />
        </div>
      )}
      <img
        ref={imgRef}
        src={currentSrc}
        width={width}
        height={height}
        style={{ 
          objectFit: 'cover', 
          display: isLoading ? 'none' : 'block',
          ...style 
        }}
        alt={img.alt || '商家图片'}
        onLoad={handleLoad}
        onError={handleError}
        onClick={onClick}
      />
    </div>
  )
}

// 支持的目标国家/语言配置
const TARGET_COUNTRIES = [
  { code: 'US', name: '美国', language: 'en-US', languageName: 'English (US)', flag: '🇺🇸' },
  { code: 'GB', name: '英国', language: 'en-GB', languageName: 'English (UK)', flag: '🇬🇧' },
  { code: 'CA', name: '加拿大', language: 'en-CA', languageName: 'English (CA)', flag: '🇨🇦' },
  { code: 'AU', name: '澳大利亚', language: 'en-AU', languageName: 'English (AU)', flag: '🇦🇺' },
  { code: 'DE', name: '德国', language: 'de', languageName: 'Deutsch', flag: '🇩🇪' },
  { code: 'FR', name: '法国', language: 'fr', languageName: 'Français', flag: '🇫🇷' },
  { code: 'ES', name: '西班牙', language: 'es', languageName: 'Español', flag: '🇪🇸' },
  { code: 'IT', name: '意大利', language: 'it', languageName: 'Italiano', flag: '🇮🇹' },
  { code: 'JP', name: '日本', language: 'ja', languageName: '日本語', flag: '🇯🇵' },
  { code: 'KR', name: '韩国', language: 'ko', languageName: '한국어', flag: '🇰🇷' },
  { code: 'BR', name: '巴西', language: 'pt-BR', languageName: 'Português (BR)', flag: '🇧🇷' },
  { code: 'MX', name: '墨西哥', language: 'es-MX', languageName: 'Español (MX)', flag: '🇲🇽' },
  { code: 'NL', name: '荷兰', language: 'nl', languageName: 'Nederlands', flag: '🇳🇱' },
  { code: 'PL', name: '波兰', language: 'pl', languageName: 'Polski', flag: '🇵🇱' },
  { code: 'SE', name: '瑞典', language: 'sv', languageName: 'Svenska', flag: '🇸🇪' },
]

const LuchuCreate = () => {
  const navigate = useNavigate()
  const [currentStep, setCurrentStep] = useState(0)
  const [loading, setLoading] = useState(false)
  const [analyzing, setAnalyzing] = useState(false)
  const [generating, setGenerating] = useState(false)
  
  // 数据
  const [websites, setWebsites] = useState([])
  const [templates, setTemplates] = useState([])
  const [merchantData, setMerchantData] = useState(null)
  const [selectedImages, setSelectedImages] = useState([])
  const [articleData, setArticleData] = useState(null)
  
  // 手动上传的图片
  const [uploadedImages, setUploadedImages] = useState([])
  const [uploading, setUploading] = useState(false)
  
  // 表单
  const [step1Form] = Form.useForm()
  const [step2Form] = Form.useForm()

  useEffect(() => {
    loadInitData()
  }, [])

  const loadInitData = async () => {
    try {
      const [websitesRes, templatesRes] = await Promise.all([
        getWebsites(),
        getPromptTemplates()
      ])
      setWebsites(websitesRes.data)
      setTemplates(templatesRes.data)
    } catch (error) {
      console.error('加载初始数据失败:', error)
    }
  }

  // 分析状态提示
  const [analyzeStatus, setAnalyzeStatus] = useState('')
  const [analyzeProgress, setAnalyzeProgress] = useState(0)

  // 步骤1：分析商家URL（异步任务 + 轮询模式）
  const handleAnalyze = async (values) => {
    setAnalyzing(true)
    setAnalyzeStatus('正在创建分析任务...')
    setAnalyzeProgress(0)
    
    try {
      // 1. 创建分析任务
      const response = await analyzeMerchant(values.merchant_url)
      const { task_id, status: initialStatus, message: taskMessage } = response.data
      
      // 如果任务直接完成（使用缓存）
      if (initialStatus === 'completed') {
        setAnalyzeProgress(100)
        setAnalyzeStatus('分析完成（使用缓存）')
        
        // 获取完整结果
        const statusResponse = await getAnalyzeTaskStatus(task_id)
        const resultData = statusResponse.data.data
        
        setMerchantData(resultData)
        if (resultData.images) {
          setSelectedImages(resultData.images.map((_, i) => i))
        }
        step2Form.setFieldsValue({
          brand_name: resultData.brand_name,
          keyword_count: 10,
          target_country: 'US'
        })
        
        message.success('分析完成')
        setCurrentStep(1)
        return
      }
      
      // 2. 轮询等待任务完成
      const resultData = await pollAnalyzeTask(
        task_id,
        (progress, stage) => {
          setAnalyzeProgress(progress)
          setAnalyzeStatus(stage || '正在分析中...')
        },
        2000,  // 2秒轮询间隔
        180000 // 最长等待3分钟
      )
      
      // 3. 处理结果
      setMerchantData(resultData)
      
      // 默认选中所有图片
      if (resultData.images) {
        setSelectedImages(resultData.images.map((_, i) => i))
      }
      
      // 预填充表单
      step2Form.setFieldsValue({
        brand_name: resultData.brand_name,
        keyword_count: 10,
        target_country: 'US'
      })
      
      message.success('分析完成')
      setCurrentStep(1)
      
    } catch (error) {
      console.error('分析失败:', error)
      message.error(error.message || error.response?.data?.detail || '分析失败，请检查URL是否正确')
    } finally {
      setAnalyzing(false)
      setAnalyzeStatus('')
      setAnalyzeProgress(0)
    }
  }

  // 步骤2：生成文章
  const handleGenerate = async (values) => {
    if (!merchantData) {
      message.error('请先分析商家URL')
      return
    }

    setGenerating(true)
    try {
      // 构建选中的 AI 提取图片
      const aiImages = selectedImages.map(i => {
        const img = merchantData.images[i]
        return {
          ...img,
          url: img.url || img.src || '',
          type: img.type || (i === 0 ? 'hero' : 'content'),
          source: 'ai'
        }
      })
      
      // 合并手动上传的图片
      const allImages = [...aiImages, ...uploadedImages]
      
      // 确保至少有一张图片时，第一张为 hero
      const images = allImages.map((img, i) => ({
        ...img,
        type: i === 0 ? 'hero' : 'content'
      }))
      
      // 获取目标国家信息
      const targetCountry = TARGET_COUNTRIES.find(c => c.code === values.target_country) || TARGET_COUNTRIES[0]
      
      const response = await generateArticle({
        merchant_data: merchantData,
        tracking_link: values.tracking_link,
        website_id: values.website_id,
        keyword_count: values.keyword_count,
        publish_date: values.publish_date?.format('YYYY-MM-DD'),
        prompt_template_id: values.prompt_template_id,
        images: images,
        target_country: targetCountry.code,
        target_language: targetCountry.language,
        target_country_name: targetCountry.name
      })
      
      setArticleData({
        ...response.data,
        website_id: values.website_id,
        tracking_link: values.tracking_link,
        merchant_url: step1Form.getFieldValue('merchant_url'),
        brand_name: values.brand_name,
        keyword_count: values.keyword_count,
        publish_date: values.publish_date?.format('YYYY-MM-DD'),
        target_country: targetCountry.code,
        target_language: targetCountry.language
      })
      
      message.success('文章生成完成')
      setCurrentStep(2)
    } catch (error) {
      console.error('生成失败:', error)
      message.error(error.response?.data?.detail || '文章生成失败')
    } finally {
      setGenerating(false)
    }
  }

  // 步骤3：保存文章
  const handleSave = async () => {
    if (!articleData) {
      message.error('请先生成文章')
      return
    }

    setLoading(true)
    try {
      const response = await createArticle({
        website_id: articleData.website_id,
        title: articleData.title,
        slug: articleData.slug,
        category: articleData.category,
        category_name: articleData.category_name,
        excerpt: articleData.excerpt,
        content: articleData.content,
        images: articleData.images,
        products: articleData.products,
        merchant_url: articleData.merchant_url,
        tracking_link: articleData.tracking_link,
        brand_name: articleData.brand_name,
        keyword_count: articleData.keyword_count,
        publish_date: articleData.publish_date
      })
      
      message.success('文章创建成功')
      navigate(`/luchu/articles/${response.data.id}`)
    } catch (error) {
      console.error('保存失败:', error)
      message.error(error.response?.data?.detail || '保存失败')
    } finally {
      setLoading(false)
    }
  }

  // 图片选择
  const toggleImageSelection = (index) => {
    setSelectedImages(prev => {
      if (prev.includes(index)) {
        return prev.filter(i => i !== index)
      } else {
        return [...prev, index]
      }
    })
  }

  // 手动上传图片处理
  const handleUploadImage = async (options) => {
    const { file, onSuccess, onError } = options
    
    // 验证文件类型
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']
    if (!allowedTypes.includes(file.type)) {
      message.error('仅支持 JPG/PNG/WebP/GIF 格式')
      onError(new Error('不支持的文件类型'))
      return
    }
    
    // 验证文件大小（5MB）
    if (file.size > 5 * 1024 * 1024) {
      message.error('图片大小不能超过 5MB')
      onError(new Error('文件太大'))
      return
    }
    
    setUploading(true)
    try {
      const response = await uploadImage(file)
      const imgData = {
        url: response.data.url,
        base64: response.data.base64,
        alt: file.name.replace(/\.[^.]+$/, ''),
        type: uploadedImages.length === 0 && (!merchantData?.images?.length) ? 'hero' : 'content',
        source: 'upload',
        filename: response.data.filename
      }
      
      setUploadedImages(prev => [...prev, imgData])
      message.success('图片上传成功')
      onSuccess(response.data)
    } catch (error) {
      console.error('上传失败:', error)
      message.error(error.response?.data?.detail || '上传失败')
      onError(error)
    } finally {
      setUploading(false)
    }
  }

  // 删除已上传的图片
  const handleRemoveUploadedImage = (index) => {
    setUploadedImages(prev => prev.filter((_, i) => i !== index))
  }

  return (
    <div style={{ padding: '24px', maxWidth: 1200, margin: '0 auto' }}>
      <Title level={3}>创建露出内容</Title>
      
      <Steps current={currentStep} style={{ marginBottom: 32 }}>
        <Step title="分析商家" icon={analyzing ? <LoadingOutlined /> : <LinkOutlined />} />
        <Step title="配置生成" icon={generating ? <LoadingOutlined /> : <RobotOutlined />} />
        <Step title="预览保存" icon={<EditOutlined />} />
      </Steps>

      {/* 步骤1：分析商家URL */}
      {currentStep === 0 && (
        <Card>
          <Form
            form={step1Form}
            layout="vertical"
            onFinish={handleAnalyze}
          >
            <Form.Item
              name="merchant_url"
              label="商家网站URL"
              rules={[
                { required: true, message: '请输入商家网站URL' },
                { type: 'url', message: '请输入有效的URL' }
              ]}
            >
              <Input 
                placeholder="https://example.com" 
                prefix={<LinkOutlined />}
                size="large"
              />
            </Form.Item>
            
            {analyzing ? (
              <div style={{ marginBottom: 16 }}>
                <Alert
                  message={analyzeStatus || "正在分析中..."}
                  description={
                    <div style={{ marginTop: 8 }}>
                      <Progress 
                        percent={analyzeProgress} 
                        status="active"
                        strokeColor={{
                          '0%': '#108ee9',
                          '100%': '#87d068',
                        }}
                      />
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        异步任务处理中，无超时风险，请耐心等待...
                      </Text>
                    </div>
                  }
                  type="warning"
                  showIcon
                />
              </div>
            ) : (
              <Alert
                message="AI 将自动分析商家网站，提取品牌信息和适合的配图"
                type="info"
                showIcon
                style={{ marginBottom: 16 }}
              />
            )}
            
            <Form.Item>
              <Button 
                type="primary" 
                htmlType="submit" 
                loading={analyzing}
                icon={<RobotOutlined />}
                size="large"
              >
                {analyzing ? '分析中...' : '开始分析'}
              </Button>
            </Form.Item>
          </Form>
        </Card>
      )}

      {/* 步骤2：配置生成 */}
      {currentStep === 1 && merchantData && (
        <Row gutter={24}>
          <Col xs={24} md={12}>
            <Card title="商家信息">
              <Paragraph>
                <Text strong>品牌名称：</Text>
                {merchantData.brand_name}
              </Paragraph>
              <Paragraph>
                <Text strong>品牌描述：</Text>
                {merchantData.brand_description || '-'}
              </Paragraph>
              <Paragraph>
                <Text strong>产品类型：</Text>
                {merchantData.product_type || '-'}
              </Paragraph>
              {merchantData.promotions && merchantData.promotions.length > 0 && (
                <Paragraph>
                  <Text strong>促销活动：</Text>
                  <ul>
                    {merchantData.promotions.map((p, i) => (
                      <li key={i}>{p}</li>
                    ))}
                  </ul>
                </Paragraph>
              )}
              
              <Divider>选择配图 (点击选择/取消)</Divider>
              
              {(!merchantData.images || merchantData.images.length === 0) && (
                <Alert 
                  message="未能获取到商家图片" 
                  description="请检查商家网站是否可访问，或尝试重新分析"
                  type="warning" 
                  showIcon 
                  style={{ marginBottom: 16 }}
                />
              )}
              
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {merchantData.images?.map((img, index) => (
                  <div 
                    key={index} 
                    onClick={() => toggleImageSelection(index)}
                    style={{ 
                      cursor: 'pointer',
                      border: selectedImages.includes(index) ? '3px solid #1890ff' : '1px solid #d9d9d9',
                      borderRadius: 4,
                      padding: 4,
                      position: 'relative',
                      background: '#f5f5f5'
                    }}
                  >
                    <SmartImage 
                      img={img} 
                      width={100} 
                      height={100}
                    />
                    {selectedImages.includes(index) && (
                      <CheckOutlined style={{ 
                        position: 'absolute', 
                        top: 4, 
                        right: 4, 
                        color: '#1890ff',
                        fontSize: 16,
                        background: 'white',
                        borderRadius: '50%',
                        padding: 2
                      }} />
                    )}
                  </div>
                ))}
              </div>
              
              {/* 手动上传图片区域 */}
              <Divider>手动上传图片</Divider>
              
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
                {/* 显示已上传的图片 */}
                {uploadedImages.map((img, index) => (
                  <div 
                    key={`uploaded-${index}`}
                    style={{ 
                      position: 'relative',
                      border: '2px solid #52c41a',
                      borderRadius: 4,
                      padding: 4,
                      background: '#f6ffed'
                    }}
                  >
                    <SmartImage 
                      img={img} 
                      width={100} 
                      height={100}
                    />
                    <div
                      onClick={() => handleRemoveUploadedImage(index)}
                      style={{
                        position: 'absolute',
                        top: -8,
                        right: -8,
                        width: 20,
                        height: 20,
                        borderRadius: '50%',
                        background: '#ff4d4f',
                        color: 'white',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        cursor: 'pointer',
                        fontSize: 12
                      }}
                    >
                      <DeleteOutlined />
                    </div>
                    <div style={{
                      position: 'absolute',
                      bottom: 4,
                      left: 4,
                      right: 4,
                      background: 'rgba(82, 196, 26, 0.9)',
                      color: 'white',
                      fontSize: 10,
                      textAlign: 'center',
                      borderRadius: 2,
                      padding: '1px 4px'
                    }}>
                      已上传
                    </div>
                  </div>
                ))}
                
                {/* 上传按钮 */}
                <Upload
                  customRequest={handleUploadImage}
                  showUploadList={false}
                  accept=".jpg,.jpeg,.png,.webp,.gif"
                  disabled={uploading}
                >
                  <div 
                    style={{ 
                      width: 100, 
                      height: 100, 
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center', 
                      justifyContent: 'center',
                      border: '2px dashed #d9d9d9',
                      borderRadius: 4,
                      cursor: uploading ? 'not-allowed' : 'pointer',
                      background: '#fafafa',
                      transition: 'all 0.3s'
                    }}
                    onMouseEnter={(e) => {
                      if (!uploading) e.currentTarget.style.borderColor = '#1890ff'
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.borderColor = '#d9d9d9'
                    }}
                  >
                    {uploading ? (
                      <LoadingOutlined style={{ fontSize: 24, color: '#1890ff' }} />
                    ) : (
                      <>
                        <PlusOutlined style={{ fontSize: 20, color: '#999' }} />
                        <span style={{ fontSize: 12, color: '#999', marginTop: 4 }}>上传图片</span>
                      </>
                    )}
                  </div>
                </Upload>
              </div>
              
              <Alert
                message="提示"
                description="如果自动提取的图片无法显示或不满意，可手动上传本地图片。支持 JPG/PNG/WebP/GIF，单张最大 5MB。"
                type="info"
                showIcon
                style={{ marginBottom: 0 }}
              />
            </Card>
          </Col>
          
          <Col xs={24} md={12}>
            <Card title="生成配置">
              <Form
                form={step2Form}
                layout="vertical"
                onFinish={handleGenerate}
              >
                <Form.Item
                  name="website_id"
                  label="发布网站"
                  rules={[{ required: true, message: '请选择发布网站' }]}
                >
                  <Select placeholder="选择网站">
                    {websites.map(w => (
                      <Select.Option key={w.id} value={w.id}>
                        {w.name} ({w.domain})
                      </Select.Option>
                    ))}
                  </Select>
                </Form.Item>
                
                <Form.Item
                  name="target_country"
                  label="目标国家/语言"
                  rules={[{ required: true, message: '请选择目标国家' }]}
                  tooltip="文章将使用该国家的语言和本地化表达方式"
                  initialValue="US"
                >
                  <Select 
                    placeholder="选择目标国家"
                    showSearch
                    optionFilterProp="children"
                  >
                    {TARGET_COUNTRIES.map(c => (
                      <Select.Option key={c.code} value={c.code}>
                        {c.flag} {c.name} - {c.languageName}
                      </Select.Option>
                    ))}
                  </Select>
                </Form.Item>
                
                <Form.Item
                  name="tracking_link"
                  label="追踪链接"
                  rules={[{ required: true, message: '请输入追踪链接' }]}
                >
                  <Input placeholder="联盟追踪链接" />
                </Form.Item>
                
                <Form.Item
                  name="brand_name"
                  label="品牌名称（关键词）"
                  rules={[{ required: true, message: '请输入品牌名称' }]}
                >
                  <Input />
                </Form.Item>
                
                <Form.Item
                  name="keyword_count"
                  label="关键词出现次数"
                  initialValue={10}
                >
                  <InputNumber min={3} max={30} />
                </Form.Item>
                
                <Form.Item
                  name="publish_date"
                  label="计划发布日期"
                >
                  <DatePicker style={{ width: '100%' }} />
                </Form.Item>
                
                <Form.Item
                  name="prompt_template_id"
                  label="提示词模板"
                >
                  <Select placeholder="使用默认模板" allowClear>
                    {templates.map(t => (
                      <Select.Option key={t.id} value={t.id}>
                        {t.name} {t.is_default && '(默认)'}
                      </Select.Option>
                    ))}
                  </Select>
                </Form.Item>
                
                <Form.Item>
                  <Space>
                    <Button onClick={() => setCurrentStep(0)}>
                      上一步
                    </Button>
                    <Button 
                      type="primary" 
                      htmlType="submit" 
                      loading={generating}
                      icon={<RobotOutlined />}
                    >
                      生成文章
                    </Button>
                  </Space>
                </Form.Item>
              </Form>
            </Card>
          </Col>
        </Row>
      )}

      {/* 步骤3：预览保存 */}
      {currentStep === 2 && articleData && (
        <Card>
          <Row gutter={24}>
            <Col xs={24} md={16}>
              <Card title="文章预览" type="inner">
                <Title level={4}>{articleData.title}</Title>
                
                <Space style={{ marginBottom: 16 }}>
                  <Text type="secondary">分类：{articleData.category_name}</Text>
                  <Text type="secondary">|</Text>
                  <Text type="secondary">Slug：{articleData.slug}</Text>
                </Space>
                
                <Paragraph type="secondary" italic>
                  {articleData.excerpt}
                </Paragraph>
                
                <Divider />
                
                <div 
                  dangerouslySetInnerHTML={{ __html: articleData.content }} 
                  style={{ lineHeight: 1.8 }}
                />
              </Card>
            </Col>
            
            <Col xs={24} md={8}>
              <Card title="文章信息" type="inner" style={{ marginBottom: 16 }}>
                <Paragraph>
                  <Text strong>关键词出现：</Text>
                  {articleData.keyword_actual_count || '-'} 次
                </Paragraph>
                
                {articleData.images?.hero && (
                  <div style={{ marginTop: 16 }}>
                    <Text strong>主图：</Text>
                    <SmartImage 
                      img={articleData.images.hero}
                      width="100%"
                      height={200}
                      style={{ marginTop: 8, maxHeight: 300, borderRadius: 4 }}
                    />
                  </div>
                )}
              </Card>
              
              {articleData.products && articleData.products.length > 0 && (
                <Card title="产品推荐" type="inner" style={{ marginBottom: 16 }}>
                  <List
                    size="small"
                    dataSource={articleData.products}
                    renderItem={(product) => (
                      <List.Item>
                        <List.Item.Meta
                          title={product.name}
                          description={`${product.price || ''} ${product.description || ''}`}
                        />
                      </List.Item>
                    )}
                  />
                </Card>
              )}
              
              <Space direction="vertical" style={{ width: '100%' }}>
                <Button 
                  type="primary" 
                  block 
                  size="large"
                  onClick={handleSave}
                  loading={loading}
                  icon={<CheckOutlined />}
                >
                  保存文章
                </Button>
                
                <Button 
                  block
                  onClick={() => {
                    setCurrentStep(1)
                    setArticleData(null)
                  }}
                  icon={<ReloadOutlined />}
                >
                  重新生成
                </Button>
                
                <Button 
                  block
                  onClick={() => {
                    setCurrentStep(0)
                    setMerchantData(null)
                    setArticleData(null)
                    step1Form.resetFields()
                    step2Form.resetFields()
                  }}
                >
                  重新开始
                </Button>
              </Space>
            </Col>
          </Row>
        </Card>
      )}
    </div>
  )
}

export default LuchuCreate

