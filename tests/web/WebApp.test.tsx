import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WebApp from '@/WebApp'
import WebSettingsPage from '@/web/WebSettingsPage'
import * as webAiClient from '@/web/webAiClient'
import { useEditorStore } from '@/stores/editorStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useToastStore } from '@/stores/toastStore'
import { requestWebAiChat, resolveWebChatCompletionsUrl, testWebAiConnection } from '@/web/webAiClient'
import {
  saveEncryptedWebApiKeys,
  unlockEncryptedWebApiKeys,
  WEB_API_KEY_STORAGE_KEY,
  WEB_PLAINTEXT_API_KEYS_STORAGE_KEY,
} from '@/web/webSecretStorage'

beforeEach(() => {
  localStorage.clear()
  useToastStore.setState({ toasts: [], timers: new Map() })
  useSettingsStore.setState((state) => ({
    editor: { ...state.editor, autoSendAiShortcut: true, defaultOpenMode: 'preview' },
  }))
})
afterEach(() => vi.unstubAllGlobals())

describe('Web AI transport', () => {
  it('只允许 HTTPS 或本机回环 HTTP 地址', () => {
    expect(resolveWebChatCompletionsUrl('https://api.openai.com/v1')).toBe('https://api.openai.com/v1/chat/completions')
    expect(resolveWebChatCompletionsUrl('http://localhost:11434/v1')).toBe('http://localhost:11434/v1/chat/completions')
    expect(() => resolveWebChatCompletionsUrl('http://example.com/v1')).toThrow('仅允许 HTTPS')
  })

  it('通过 OpenAI-compatible Chat Completions 发送请求', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: '回答内容' } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(requestWebAiChat({
      baseUrl: 'https://example.com/v1',
      apiKey: 'secret-key',
      model: 'test-model',
      messages: [{ role: 'user', content: '你好' }],
    })).resolves.toBe('回答内容')

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://example.com/v1/chat/completions')
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer secret-key')
    expect(init.redirect).toBe('error')
    expect(JSON.parse(String(init.body))).toEqual({
      model: 'test-model',
      messages: [{ role: 'user', content: '你好' }],
      stream: false,
    })
  })

  it('Web 连通性测试直接使用浏览器 fetch 并返回成功', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(testWebAiConnection({
      baseUrl: 'https://example.com/v1',
      apiKey: 'secret-key',
      model: 'test-model',
      timeoutMs: 5_000,
    })).resolves.toEqual({ ok: true })

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://example.com/v1/chat/completions')
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer secret-key')
    expect(init.mode).toBe('cors')
    expect(init.redirect).toBe('error')
    expect(JSON.parse(String(init.body))).toEqual({
      model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 5,
      stream: false,
    })
  })

  it.each([
    [401, 'auth_failed', 'API Key 无效或权限不足'],
    [403, 'auth_failed', 'API Key 无效或权限不足'],
    [404, 'not_found', '端点或模型不存在，请检查 Base URL 和模型名称'],
    [400, 'bad_request', '请求参数被拒绝，可能是模型名称不支持'],
    [422, 'bad_request', '请求参数被拒绝，可能是模型名称不支持'],
  ])('连通性测试映射 HTTP %s', async (status, error, message) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status })))

    await expect(testWebAiConnection({
      baseUrl: 'https://example.com/v1',
      apiKey: 'secret-key',
      model: 'test-model',
      timeoutMs: 5_000,
    })).resolves.toEqual({ ok: false, error, message })
  })

  it('连通性测试区分超时和浏览器网络/CORS 失败', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn((_input: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    }))
    vi.stubGlobal('fetch', fetchMock)
    const timeoutResult = testWebAiConnection({
      baseUrl: 'https://example.com/v1',
      apiKey: 'secret-key',
      model: 'test-model',
      timeoutMs: 5_000,
    })
    await vi.advanceTimersByTimeAsync(5_000)
    await expect(timeoutResult).resolves.toMatchObject({ ok: false, error: 'timeout' })

    vi.useRealTimers()
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    await expect(testWebAiConnection({
      baseUrl: 'https://example.com/v1',
      apiKey: 'secret-key',
      model: 'test-model',
      timeoutMs: 5_000,
    })).resolves.toEqual({
      ok: false,
      error: 'network_error',
      message: '网络连接失败：API 请求失败，请确认地址可访问且服务允许浏览器跨域请求',
    })
  })
})

describe('Web API Key 加密存储', () => {
  it('用一个密码加密两把 Key，正确密码同时解锁且错误密码失败', async () => {
    vi.stubGlobal('crypto', webcrypto)
    await saveEncryptedWebApiKeys({ chatApiKey: 'sk-chat-secret', webSearchApiKey: 'sk-search-secret' }, 'local-password')

    const saved = localStorage.getItem(WEB_API_KEY_STORAGE_KEY) ?? ''
    expect(saved).not.toContain('sk-chat-secret')
    expect(saved).not.toContain('sk-search-secret')
    expect(saved).not.toContain('local-password')
    await expect(unlockEncryptedWebApiKeys('local-password')).resolves.toEqual({
      chatApiKey: 'sk-chat-secret',
      webSearchApiKey: 'sk-search-secret',
    })
    await expect(unlockEncryptedWebApiKeys('wrong-password')).rejects.toThrow('密码不正确')
  })

  it('兼容旧版单 Key 密文并归入对话 API', async () => {
    vi.stubGlobal('crypto', webcrypto)
    localStorage.setItem(WEB_API_KEY_STORAGE_KEY, JSON.stringify({
      version: 1,
      iterations: 600_000,
      salt: 'BwcHBwcHBwcHBwcHBwcHBw==',
      iv: 'CQkJCQkJCQkJCQkJ',
      ciphertext: 'MvSm5QiMgBEPOld1zdHohHo8ulBrTnUmUK2CSlTw/tC9qRo=',
    }))

    await expect(unlockEncryptedWebApiKeys('legacy-password')).resolves.toEqual({
      chatApiKey: 'sk-legacy-anonymous',
      webSearchApiKey: '',
    })
  })
})

describe('WebApp', () => {
  it('设置页的 AI 测试连接调用 Web 专用测试函数', async () => {
    const user = userEvent.setup()
    const testSpy = vi.spyOn(webAiClient, 'testWebAiConnection').mockResolvedValue({ ok: true })
    render(<WebSettingsPage />)
    await user.click(screen.getAllByText('测试连接')[0])
    await waitFor(() => expect(testSpy).toHaveBeenCalledTimes(1))
    expect(screen.getByText('连接成功')).toBeInTheDocument()
    testSpy.mockRestore()
  })

  it('直接渲染共享桌面壳并保留浏览器可用入口', async () => {
    render(<WebApp />)
    expect(screen.getByText('观墨')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '打开文件' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '打开文件夹' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '设置' })).toBeInTheDocument()
  })

  it('网页会话使用默认打开模式并默认显示预览', () => {
    render(<WebApp />)
    expect(useEditorStore.getState().viewMode).toBe('preview')
    expect(useEditorStore.getState().previewVisible).toBe(true)
  })

  it('网页会话尊重设置的编辑模式', () => {
    useSettingsStore.setState((state) => ({
      editor: { ...state.editor, defaultOpenMode: 'edit' },
    }))
    render(<WebApp />)
    expect(useEditorStore.getState().viewMode).toBe('edit')
    expect(useEditorStore.getState().previewVisible).toBe(false)
  })

  it('网页首次访问显示导览 Toast，并记录邀请状态', async () => {
    const { unmount } = render(<WebApp />)
    expect(await screen.findByRole('button', { name: '开始导览' })).toBeInTheDocument()
    expect(localStorage.getItem('guanmo-product-tour-invite-v1')).toBe('1')

    unmount()
    render(<WebApp />)
    expect(screen.getAllByRole('button', { name: '开始导览' })).toHaveLength(1)
  })

  it('网页设置页提供产品导览入口', async () => {
    const user = userEvent.setup()
    render(<WebApp />)
    await user.click(screen.getByRole('button', { name: '设置' }))
    await user.click(await screen.findByText('通用'))
    await user.click(await screen.findByRole('button', { name: '产品导览' }))
    expect(await screen.findByRole('dialog', { name: '打开文件 / 文件夹' })).toBeInTheDocument()
  })

  it('设置弹窗提供 Web Key 配置，Embedding 入口保持禁用', async () => {
    const user = userEvent.setup()
    render(<WebApp />)
    await user.click(screen.getByRole('button', { name: '设置' }))
    expect(await screen.findByLabelText('对话 API Key')).toBeInTheDocument()
    await user.click(screen.queryByText('DuckDuckGo（免费）') ?? screen.getByText('Tavily'))
    const tavilyOptions = await screen.findAllByText('Tavily')
    await user.click(tavilyOptions[tavilyOptions.length - 1])
    expect(screen.getByLabelText('联网搜索 API Key')).toBeInTheDocument()
    expect(screen.getByText('Embedding 在 Web 端固定禁用。')).toBeInTheDocument()
  })

  it('设置弹窗保留对话服务预设并自动填充配置', async () => {
    const user = userEvent.setup()
    render(<WebApp />)
    await user.click(screen.getByRole('button', { name: '设置' }))

    const presetTrigger = screen.getByText('自定义')
    await user.click(presetTrigger)
    const openaiOptions = await screen.findAllByText('OpenAI')
    await user.click(openaiOptions[openaiOptions.length - 1])

    expect(screen.getByLabelText('对话 API 地址')).toHaveValue('https://api.openai.com/v1')
    expect(screen.getByLabelText('对话模型')).toHaveValue('gpt-4o-mini')
  })

  it('明文 LocalStorage 必须经过风险确认后才保存双 Key', async () => {
    const user = userEvent.setup()
    render(<WebApp />)
    await user.click(screen.getByRole('button', { name: '设置' }))
    await user.type(await screen.findByLabelText('对话 API Key'), 'sk-chat')
    await user.click(screen.queryByText('DuckDuckGo（免费）') ?? screen.getByText('Tavily'))
    const tavilyOptions = await screen.findAllByText('Tavily')
    await user.click(tavilyOptions[tavilyOptions.length - 1])
    await user.type(screen.getByLabelText('联网搜索 API Key'), 'sk-search')
    await user.click(screen.getByText('仅当前页面内存'))
    await user.click(await screen.findByText('明文 LocalStorage（低安全性）'))
    await user.click(screen.getByRole('button', { name: '保存 Key' }))
    expect(screen.getByRole('dialog', { name: '低安全性存储' })).toBeInTheDocument()
    expect(localStorage.getItem(WEB_PLAINTEXT_API_KEYS_STORAGE_KEY)).toBeNull()
    await user.click(screen.getByRole('button', { name: '仍然保存' }))
    expect(JSON.parse(localStorage.getItem(WEB_PLAINTEXT_API_KEYS_STORAGE_KEY) || '{}')).toMatchObject({
      chatApiKey: 'sk-chat',
      webSearchApiKey: 'sk-search',
    })
  })

  it('刷新会话不恢复文件和聊天状态', () => {
    const { unmount } = render(<WebApp />)
    unmount()
    render(<WebApp />)
    expect(screen.queryByText('AI 助手')).not.toBeInTheDocument()
  })
})
