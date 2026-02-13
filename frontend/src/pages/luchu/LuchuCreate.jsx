/**
 * 露出内容创建页面
 */
import React, { useState, useEffect } from 'react'
import { 
  Card, Steps, Form, Input, Select, Button, Row, Col, 
  Spin, message, DatePicker, InputNumber, Image, Space,
  Typography, Alert, Divider, List, Checkbox
} from 'antd'
import { 
  LinkOutlined, RobotOutlined, EditOutlined, 
  CheckOutlined, LoadingOutlined, ReloadOutlined
} from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { 
  analyzeMerchant, 
  generateArticle, 
  createArticle,
  getWebsites,
  getPromptTemplates
} from '../../services/luchuApi'
import dayjs from 'dayjs'

const { Title, Text, Paragraph } = Typography
const { TextArea } = Input
const { Step } = Steps

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

  // 步骤1：分析商家URL
  const handleAnalyze = async (values) => {
    setAnalyzing(true)
    try {
      const response = await analyzeMerchant(values.merchant_url)
      setMerchantData(response.data)
      
      // 默认选中所有图片
      if (response.data.images) {
        setSelectedImages(response.data.images.map((_, i) => i))
      }
      
      // 预填充表单
      step2Form.setFieldsValue({
        brand_name: response.data.brand_name,
        keyword_count: 10
      })
      
      message.success('分析完成')
      setCurrentStep(1)
    } catch (error) {
      console.error('分析失败:', error)
      message.error(error.response?.data?.detail || '分析失败，请检查URL是否正确')
    } finally {
      setAnalyzing(false)
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
      // 构建选中的图片
      const images = selectedImages.map(i => merchantData.images[i])
      
      const response = await generateArticle({
        merchant_data: merchantData,
        tracking_link: values.tracking_link,
        website_id: values.website_id,
        keyword_count: values.keyword_count,
        publish_date: values.publish_date?.format('YYYY-MM-DD'),
        prompt_template_id: values.prompt_template_id,
        images: images
      })
      
      setArticleData({
        ...response.data,
        website_id: values.website_id,
        tracking_link: values.tracking_link,
        merchant_url: step1Form.getFieldValue('merchant_url'),
        brand_name: values.brand_name,
        keyword_count: values.keyword_count,
        publish_date: values.publish_date?.format('YYYY-MM-DD')
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
            
            <Alert
              message="AI 将自动分析商家网站，提取品牌信息和适合的配图"
              type="info"
              showIcon
              style={{ marginBottom: 16 }}
            />
            
            <Form.Item>
              <Button 
                type="primary" 
                htmlType="submit" 
                loading={analyzing}
                icon={<RobotOutlined />}
                size="large"
              >
                开始分析
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
                      position: 'relative'
                    }}
                  >
                    <Image
                      src={img.url}
                      width={100}
                      height={100}
                      style={{ objectFit: 'cover' }}
                      preview={false}
                      fallback="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
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
                    <Image
                      src={articleData.images.hero.url}
                      width="100%"
                      style={{ marginTop: 8 }}
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

