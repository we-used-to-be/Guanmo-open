import { externalFetch } from './externalHttp'

export interface SearchResult {
  title: string
  url: string
  snippet: string
  siteName?: string
  publishedAt?: string
}

export interface SearchResponse {
  results: SearchResult[]
  query: string
  totalResults: number
}

export type SearchProvider = 'tavily' | 'serper' | 'brave' | 'duckduckgo' | 'custom'

export interface WebSearchConfig {
  provider: SearchProvider
  apiKey: string
  maxResults: number
  customUrl?: string
}

const DEFAULT_CONFIG: WebSearchConfig = {
  provider: 'duckduckgo',
  apiKey: '',
  maxResults: 5,
}

let searchConfig: WebSearchConfig = { ...DEFAULT_CONFIG }

export function updateSearchConfig(config: Partial<WebSearchConfig>) {
  searchConfig = { ...searchConfig, ...config }
}

export function getSearchConfig(): WebSearchConfig {
  return { ...searchConfig }
}

const SEARCH_TIMEOUT = 15000

function siteNameFromUrl(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return undefined
  }
}

function normalizeSearchResult(result: SearchResult): SearchResult {
  return {
    ...result,
    siteName: result.siteName || siteNameFromUrl(result.url),
  }
}

function createCombinedAbortSignal(signal?: AbortSignal): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort('timeout'), SEARCH_TIMEOUT)
  const forwardAbort = () => controller.abort(signal?.reason || 'aborted')
  signal?.addEventListener('abort', forwardAbort, { once: true })
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', forwardAbort)
    },
  }
}

/**
 * Tavily Search API
 */
async function searchTavily(query: string, maxResults: number, signal?: AbortSignal): Promise<SearchResponse> {
  const abort = createCombinedAbortSignal(signal)
  try {
    const res = await externalFetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${searchConfig.apiKey}`,
      },
      body: JSON.stringify({
        query,
        max_results: maxResults,
        include_answer: true,
        include_raw_content: false,
      }),
      signal: abort.signal,
    })

    if (!res.ok) {
      let detail = ''
      try {
        const errData = await res.json()
        detail = errData.error || errData.message || ''
      } catch { /* ignore */ }
      throw new Error(`Tavily 搜索失败 (${res.status}): ${detail || res.statusText}`)
    }

    const data = await res.json()
    return {
      results: (data.results || []).map((r: { title: string; url: string; content: string; published_date?: string; publishedDate?: string }) => normalizeSearchResult({
        title: r.title,
        url: r.url,
        snippet: r.content,
        publishedAt: r.published_date || r.publishedDate,
      })),
      query,
      totalResults: data.results?.length || 0,
    }
  } finally {
    abort.cleanup()
  }
}

/**
 * Serper (Google) Search API
 */
async function searchSerper(query: string, maxResults: number, signal?: AbortSignal): Promise<SearchResponse> {
  const abort = createCombinedAbortSignal(signal)
  try {
    const res = await externalFetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: {
        'X-API-KEY': searchConfig.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        q: query,
        num: maxResults,
      }),
      signal: abort.signal,
    })

    if (!res.ok) {
      let detail = ''
      try {
        const errData = await res.json()
        detail = errData.message || ''
      } catch { /* ignore */ }
      throw new Error(`Serper 搜索失败 (${res.status}): ${detail || res.statusText}`)
    }

    const data = await res.json()
    return {
      results: (data.organic || []).map(
        (r: { title: string; link: string; snippet: string; date?: string }) => normalizeSearchResult({
          title: r.title,
          url: r.link,
          snippet: r.snippet,
          publishedAt: r.date,
        })
      ),
      query,
      totalResults: data.organic?.length || 0,
    }
  } finally {
    abort.cleanup()
  }
}

/**
 * Brave Search API
 */
async function searchBrave(query: string, maxResults: number, signal?: AbortSignal): Promise<SearchResponse> {
  const abort = createCombinedAbortSignal(signal)
  try {
    const res = await externalFetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${maxResults}`, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': searchConfig.apiKey,
      },
      signal: abort.signal,
    })

    if (!res.ok) {
      let detail = ''
      try {
        const errData = await res.json()
        detail = errData.message || errData.error || ''
      } catch { /* ignore */ }
      throw new Error(`Brave 搜索失败 (${res.status}): ${detail || res.statusText}`)
    }

    const data = await res.json()
    return {
      results: (data.web?.results || []).map(
        (r: { title: string; url: string; description: string; age?: string; page_age?: string }) => normalizeSearchResult({
          title: r.title,
          url: r.url,
          snippet: r.description,
          publishedAt: r.page_age || r.age,
        })
      ),
      query,
      totalResults: data.web?.results?.length || 0,
    }
  } finally {
    abort.cleanup()
  }
}

/**
 * Custom search engine. Sends GET request to user-defined URL.
 * Auto-detects common JSON response formats.
 */
async function searchCustom(query: string, maxResults: number, signal?: AbortSignal): Promise<SearchResponse> {
  if (!searchConfig.customUrl) {
    throw new Error('自定义搜索引擎 URL 未配置，请在设置中填写')
  }

  const url = new URL(searchConfig.customUrl)
  url.searchParams.set('q', query)
  url.searchParams.set('count', String(maxResults))

  const abort = createCombinedAbortSignal(signal)
  try {
    const headers: Record<string, string> = {
      'Accept': 'application/json',
    }
    if (searchConfig.apiKey) {
      headers['Authorization'] = `Bearer ${searchConfig.apiKey}`
    }

    const res = await externalFetch(url.toString(), { headers, signal: abort.signal })

    if (!res.ok) {
      let detail = ''
      try {
        const errData = await res.json()
        detail = errData.error || errData.message || ''
      } catch { /* ignore */ }
      throw new Error(`自定义搜索失败 (${res.status}): ${detail || res.statusText}`)
    }

    const data = await res.json()

    // 尝试从常见格式中提取结果
    const raw: unknown[] =
      data.results ??
      data.organic ??
      data.webPages?.value ??
      data.items ??
      data.hits ??
      []

    const results: SearchResult[] = raw.slice(0, maxResults).map((r) => {
      const item = r as Record<string, unknown>
      return {
        title: String(item.title ?? item.name ?? ''),
        url: String(item.url ?? item.link ?? item.href ?? ''),
        snippet: String(item.snippet ?? item.description ?? item.content ?? item.abstract ?? ''),
        siteName: typeof item.siteName === 'string' ? item.siteName
          : typeof item.site_name === 'string' ? item.site_name
            : typeof item.source === 'string' ? item.source
              : undefined,
        publishedAt: typeof item.publishedAt === 'string' ? item.publishedAt
          : typeof item.date === 'string' ? item.date
            : typeof item.published_date === 'string' ? item.published_date
              : undefined,
      }
    })

    if (results.length === 0) {
      console.warn('自定义搜索: 未解析到结果，请检查 URL 和响应格式')
    }

    return { results, query, totalResults: results.length }
  } finally {
    abort.cleanup()
  }
}

/**
 * DuckDuckGo Lite search.
 * Uses the desktop HTTP transport so the provider's browser CORS policy does not apply.
 */
async function searchDuckDuckGo(query: string, maxResults: number, signal?: AbortSignal): Promise<SearchResponse> {
  const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`
  const abort = createCombinedAbortSignal(signal)

  let res: Response
  try {
    res = await externalFetch(url, {
      signal: abort.signal,
    })
  } catch (err) {
    if ((err as Error).name === 'UnsupportedCapabilityError') throw err
    if ((err as Error).name === 'TimeoutError') {
      throw new Error('DuckDuckGo 搜索超时，请检查网络连接')
    }
    if ((err as Error).name === 'AbortError') {
      throw new Error(signal?.aborted ? 'DuckDuckGo 搜索已取消' : 'DuckDuckGo 搜索超时，请检查网络连接')
    }
    throw new Error(`DuckDuckGo 搜索失败：${(err as Error).message || String(err)}`)
  } finally {
    abort.cleanup()
  }

  if (!res.ok) {
    throw new Error(`DuckDuckGo 搜索失败 (${res.status})`)
  }

  const html = await res.text()
  const results: SearchResult[] = []

  const linkRegex = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*class="result-link"[^>]*>([^<]+)<\/a>/g
  const snippetRegex = /<td class="result-snippet">([^<]+)<\/td>/g

  const snippets: string[] = []
  let match
  while ((match = snippetRegex.exec(html)) !== null) {
    snippets.push(match[1].trim())
  }

  let i = 0
  while ((match = linkRegex.exec(html)) !== null && results.length < maxResults) {
    results.push({
      title: match[2].trim(),
      url: match[1],
      snippet: snippets[i] || '',
      siteName: siteNameFromUrl(match[1]),
    })
    i++
  }

  if (results.length === 0) {
    console.warn('DuckDuckGo: 未解析到搜索结果，页面结构可能已变更')
  }

  return {
    results,
    query,
    totalResults: results.length,
  }
}

/**
 * Perform a web search using the configured provider.
 */
export async function webSearch(query: string, signal?: AbortSignal): Promise<SearchResponse> {
  if (!query.trim()) {
    return { results: [], query, totalResults: 0 }
  }

  const maxResults = searchConfig.maxResults

  switch (searchConfig.provider) {
    case 'tavily':
      if (!searchConfig.apiKey) throw new Error('Tavily API Key 未配置，请在设置中填写')
      return searchTavily(query, maxResults, signal)
    case 'serper':
      if (!searchConfig.apiKey) throw new Error('Serper API Key 未配置，请在设置中填写')
      return searchSerper(query, maxResults, signal)
    case 'brave':
      if (!searchConfig.apiKey) throw new Error('Brave Search API Key 未配置，请在设置中填写')
      return searchBrave(query, maxResults, signal)
    case 'custom':
      return searchCustom(query, maxResults, signal)
    case 'duckduckgo':
    default:
      return searchDuckDuckGo(query, maxResults, signal)
  }
}

/**
 * Build context string from web search results for AI prompt.
 */
export function buildSearchContext(response: SearchResponse): string {
  if (response.results.length === 0) return ''

  const parts = response.results.map((r, i) => {
    return `[来源 ${i + 1}: ${r.title}]\n${r.snippet}\n链接: ${r.url}`
  })

  return `以下是网络搜索"${response.query}"的结果：\n\n${parts.join('\n\n')}`
}
