export const AI_API_KEY_SECRET = 'ai.apiKey'
export const EMBEDDING_API_KEY_SECRET = 'embedding.apiKey'
export const WEB_SEARCH_API_KEY_SECRET = 'webSearch.apiKey'
export async function saveSecret(_key: string, _value: string): Promise<void> {}
export async function loadSecret(_key: string): Promise<string | null> { return null }
export async function deleteSecret(_key: string): Promise<void> {}
